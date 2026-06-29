import "dotenv/config";
import express from "express";
import { Client, LocalAuth, Message } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

import { interpretMessage } from "./gemini";
import {
  createHandoff,
  createOrder,
  getMenu,
  notifyNewOrder,
  upsertCustomer,
} from "./supabaseClient";
import { buildSystemPrompt } from "./prompt";
import {
  getState,
  recordBotMessage,
  recordCustomerMessage,
  recordFailedAttempt,
  resetFailedAttempts,
  saveState,
  updateDelivery,
  updateProfile,
} from "./memory";
import { isRateLimited } from "./rateLimiter";
import { IncomingMessage, MenuSnapshot, OrderItem } from "./types";

const port = Number(process.env.PORT) || 5000;

// El bot es de un solo restaurante POR PROCESO: la "phoneNumberId" que usaban
// Meta Cloud API/n8n para resolver el restaurante ahora es simplemente el
// numero de WhatsApp que escanea el QR. Hay que pegar ese mismo numero (sin
// "+", como lo muestra client.info.wid.user al conectar) en el panel admin de
// RestoPOS, en Configuracion -> "Bot de WhatsApp" -> "Numero de WhatsApp del
// bot".
//
// Para varios restaurantes (SaaS): se corre este MISMO codigo varias veces,
// una vez por restaurante, cada corrida con su propio BOT_CLIENT_ID y PORT
// (y su propio numero de WhatsApp escaneado por QR). GEMINI_API_KEY y
// SUPABASE_* se mantienen iguales -- son del proveedor del software, no del
// restaurante. clientId namespacea la carpeta de sesion (.wwebjs_auth/session-<id>)
// para que las distintas corridas nunca compartan ni pisen la sesion de WhatsApp.
const clientId = process.env.BOT_CLIENT_ID || undefined;
let phoneNumberId: string | null = null;

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, connected: Boolean(phoneNumberId), clientId: clientId ?? "default" }));
app.listen(port, () => console.log(`Health check escuchando en puerto ${port}${clientId ? ` (clientId=${clientId})` : ""}`));

// whatsapp-web.js inyecta codigo que llama funciones internas del bundle JS
// de WhatsApp Web. Si se usa la version "en vivo" (la que sirve WhatsApp en
// ese momento) puede ir mas adelante que lo que whatsapp-web.js soporta, y
// fallar con errores como "X is not a function" al enviar mensajes. Fijar una
// version conocida (publicada por la comunidad en wa-version) evita eso.
const whatsappClient = new Client({
  authStrategy: new LocalAuth({ clientId }),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
  webVersionCache: {
    type: "remote",
    remotePath:
      process.env.WHATSAPP_WEB_VERSION_URL ||
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1039846915-alpha.html",
  },
});

whatsappClient.on("qr", (qr: string) => {
  qrcode.generate(qr, { small: true });
  console.log("Escanea este QR con WhatsApp en tu telefono.");
});

whatsappClient.on("ready", () => {
  phoneNumberId = whatsappClient.info.wid.user;
  console.log(`WhatsApp listo${clientId ? ` (clientId=${clientId})` : ""}. Numero del bot: ${phoneNumberId}`);
  console.log('Verifica que ese mismo numero este en RestoPOS -> Configuracion -> "Bot de WhatsApp".');
});

whatsappClient.on("message", async (msg: Message) => {
  if (msg.fromMe || !phoneNumberId) return;

  const isText = msg.type === "chat" && Boolean(msg.body?.trim());
  const isVoiceNote = (msg.type === "ptt" || msg.type === "audio") && msg.hasMedia;
  if (!isText && !isVoiceNote) {
    // Imagenes, stickers, etc. se ignoran en v1.
    return;
  }

  try {
    if (await isRateLimited(msg.from)) {
      console.warn(`Rate limit alcanzado para ${msg.from}; mensaje ignorado.`);
      return;
    }
    await handleIncomingMessage(phoneNumberId, msg);
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    await safeReply(msg.from, "Disculpa, tuvimos un problema tecnico. Intenta de nuevo en un momento.");
  }
});

whatsappClient.initialize();

// WhatsApp identifica algunos chats por un "LID" (@lid, un id de privacidad)
// en vez del numero real (@c.us) -- pasa sobre todo con cuentas/numeros mas
// nuevos. msg.from sigue siendo el id correcto para responder y como llave
// de memoria (es estable por conversacion), pero para GUARDAR el telefono en
// Supabase (customer_phone) hay que resolver el numero real detras del lid.
async function resolveCustomerPhone(chatId: string): Promise<string> {
  if (!chatId.endsWith("@lid")) return chatId;
  try {
    const [resolved] = await whatsappClient.getContactLidAndPhone([chatId]);
    return resolved?.pn || chatId;
  } catch (err) {
    console.warn("No se pudo resolver el numero real detras del @lid:", err);
    return chatId;
  }
}

async function handleIncomingMessage(currentPhoneNumberId: string, msg: Message): Promise<void> {
  const chatId = msg.from;
  const customerPhone = await resolveCustomerPhone(chatId);

  let incoming: IncomingMessage;
  let messageLabel: string;
  if (msg.type === "chat") {
    const text = msg.body.trim();
    incoming = { kind: "text", text };
    messageLabel = text;
  } else {
    const media = await msg.downloadMedia();
    if (!media) {
      console.warn("No se pudo descargar la nota de voz; mensaje ignorado.");
      return;
    }
    incoming = { kind: "audio", mimeType: media.mimetype, data: media.data };
    messageLabel = "[nota de voz]";
  }

  const menu = await getMenu(currentPhoneNumberId);
  if (!menu) {
    console.warn(`Bot de WhatsApp deshabilitado para el numero ${currentPhoneNumberId}; mensaje ignorado.`);
    return;
  }

  const state = await getState(chatId);
  recordCustomerMessage(state, messageLabel);
  const systemPrompt = buildSystemPrompt(menu, state);

  const llmResult = await interpretMessage(systemPrompt, incoming);
  // Si era una nota de voz, usamos la transcripcion del LLM como "lo que dijo
  // el cliente" para los handoffs; si no devolvio transcript, nos quedamos
  // con el placeholder.
  const messageExcerpt = llmResult?.transcript || messageLabel;

  if (!llmResult) {
    const shouldHandoff = recordFailedAttempt(state);
    const replyText = shouldHandoff
      ? "Disculpa, no logro entender bien tu pedido. Ya avise a alguien del negocio para que te atienda en breve."
      : "Disculpa, no entendi bien eso. Puedes repetir tu pedido con mas detalle?";

    recordBotMessage(state, replyText);
    await saveState(chatId, state);
    if (shouldHandoff) {
      await createHandoff(currentPhoneNumberId, customerPhone, state.profile.name, "no_entendido", messageExcerpt);
    }
    await safeReply(chatId, replyText);
    return;
  }

  if (llmResult.intent !== "handoff") {
    resetFailedAttempts(state);
  }
  updateProfile(state, llmResult.customerName, llmResult.customerEmail);
  updateDelivery(state, llmResult.deliveryType, llmResult.deliveryAddress);
  recordBotMessage(state, llmResult.replyText);
  await saveState(chatId, state);

  const profile = state.profile;

  if (llmResult.intent === "order") {
    await handleOrderIntent(
      currentPhoneNumberId,
      chatId,
      customerPhone,
      profile.name,
      profile.email,
      llmResult.items,
      menu,
      state.deliveryType,
      state.deliveryAddress
    );
    return;
  }

  if (llmResult.intent === "handoff") {
    await createHandoff(currentPhoneNumberId, customerPhone, profile.name, llmResult.reason, messageExcerpt);
    await safeReply(chatId, llmResult.replyText);
    return;
  }

  await safeReply(chatId, llmResult.replyText);
}

async function handleOrderIntent(
  currentPhoneNumberId: string,
  chatId: string,
  customerPhone: string,
  customerName: string,
  customerEmail: string,
  items: OrderItem[],
  menu: MenuSnapshot,
  deliveryType: string,
  deliveryAddress: string
): Promise<void> {
  const customer = await upsertCustomer(currentPhoneNumberId, customerName, customerEmail);
  if (!customer) {
    const replyText =
      "No pude registrar tus datos de contacto. Puedes confirmarme de nuevo tu nombre completo y un correo electronico valido?";
    const state = await getState(chatId);
    recordBotMessage(state, replyText);
    await saveState(chatId, state);
    await safeReply(chatId, replyText);
    return;
  }

  const order = await createOrder(
    currentPhoneNumberId,
    customerPhone,
    customerName,
    items,
    customer.customerId,
    deliveryType,
    deliveryAddress
  );
  if (!order) {
    const replyText =
      "No pude registrar tu pedido tal como lo escribiste. Puedes confirmarme de nuevo, uno por uno, los productos y cantidades que deseas?";
    const state = await getState(chatId);
    recordBotMessage(state, replyText);
    await saveState(chatId, state);
    await safeReply(chatId, replyText);
    return;
  }

  const notificationEmail = order.notificationEmail || menu.restaurant.notificationEmail;
  if (notificationEmail) {
    const productsById = new Map(menu.products.map((p) => [p.id, p]));
    await notifyNewOrder({
      to: notificationEmail,
      restaurantName: menu.restaurant.name,
      orderNumber: order.orderNumber,
      customerName: customerName || "Cliente WhatsApp",
      customerPhone,
      items: items.map((item) => ({
        name: productsById.get(item.productId)?.name || "Producto",
        quantity: item.quantity,
      })),
      total: order.total,
      currencyCode: "DOP",
      currencyLocale: "es-DO",
    });
  }

  const productsById = new Map(menu.products.map((p) => [p.id, p]));
  const itemLines = items
    .map((item) => `- ${item.quantity} x ${productsById.get(item.productId)?.name || "producto"}`)
    .join("\n");
  const total = new Intl.NumberFormat("es-DO", {
    style: "currency",
    currency: "DOP",
    minimumFractionDigits: 2,
  }).format(order.total || 0);

  const deliveryLine =
    deliveryType === "delivery"
      ? `Entrega a domicilio: ${deliveryAddress}`
      : "Para retirar en el restaurante";

  const replyText = `Listo! Tu pedido ${order.orderNumber} quedo registrado:\n${itemLines}\n\n${deliveryLine}\nTotal: ${total}\n\nGracias por tu compra en ${menu.restaurant.name}.`;
  const state = await getState(chatId);
  recordBotMessage(state, replyText);
  await saveState(chatId, state);
  await safeReply(chatId, replyText);
}

async function safeReply(toNumber: string, text: string): Promise<void> {
  try {
    await whatsappClient.sendMessage(toNumber, text);
  } catch (err) {
    console.error("Fallo al enviar mensaje de WhatsApp:", err);
  }
}
