import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import { Client, LocalAuth, Message } from "whatsapp-web.js";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";

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

console.log(
  `[diagnostico] Node ${process.version} arch=${process.arch} cpus=${os.cpus().length} ` +
    `memTotal=${(os.totalmem() / 1024 / 1024).toFixed(0)}MB memFree=${(os.freemem() / 1024 / 1024).toFixed(0)}MB`,
);

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
let latestQr: string | null = null;
// Pausa logica: el proceso/la sesion de WhatsApp se quedan conectados (mas
// rapido de reanudar y evita repetir todo el lanzamiento de Chromium), pero
// el bot ignora mensajes entrantes mientras esta en true. Es la forma rapida
// de "apagarlo" sin tocar Railway ni RestoPOS.
let isPaused = false;

// /qr y /health quedan en una URL publica de Railway -- sin esto, cualquiera
// que adivine o encuentre esa URL podria ver el estado del bot, o peor,
// escanear el QR el mismo y secuestrar la sesion de WhatsApp antes que el
// dueno real. BOT_ADMIN_TOKEN exige ?token=... que coincida para ver
// cualquiera de las dos rutas.
const adminToken = process.env.BOT_ADMIN_TOKEN;
if (!adminToken) {
  console.warn(
    "BOT_ADMIN_TOKEN no esta configurado: /qr y /health quedan PUBLICOS sin clave. " +
      "Configuralo en producción (ver .env.example).",
  );
}

function requireAdminToken(req: express.Request, res: express.Response): boolean {
  if (!adminToken) return true;
  const provided = (req.query.token as string | undefined) || req.header("x-admin-token");
  if (provided !== adminToken) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

const app = express();
app.use(express.json());
app.get("/health", (req, res) => {
  if (!requireAdminToken(req, res)) return;
  res.json({ ok: true, connected: Boolean(phoneNumberId), paused: isPaused, clientId: clientId ?? "default" });
});

// Panel simple para pausar/reanudar el bot con un click, sin tocar Railway
// ni RestoPOS. Pausado = sigue conectado a WhatsApp, pero ignora todo
// mensaje entrante (no responde, no gasta Gemini/Supabase).
app.get("/control", (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const token = (req.query.token as string | undefined) || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  res.send(`
    <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;gap:14px;">
      <h2>Bot de WhatsApp: ${isPaused ? "PAUSADO" : "ACTIVO"}</h2>
      <p>Conectado a WhatsApp: ${phoneNumberId ? `si (${phoneNumberId})` : "no"}</p>
      <form method="POST" action="/control/${isPaused ? "resume" : "pause"}${qs}">
        <button type="submit" style="font-size:18px;padding:10px 24px;">
          ${isPaused ? "Reanudar" : "Pausar"}
        </button>
      </form>
    </body>`);
});

app.post("/control/pause", (req, res) => {
  if (!requireAdminToken(req, res)) return;
  isPaused = true;
  console.log("Bot pausado manualmente via /control.");
  res.redirect(`/control${req.query.token ? `?token=${encodeURIComponent(req.query.token as string)}` : ""}`);
});

app.post("/control/resume", (req, res) => {
  if (!requireAdminToken(req, res)) return;
  isPaused = false;
  console.log("Bot reanudado manualmente via /control.");
  res.redirect(`/control${req.query.token ? `?token=${encodeURIComponent(req.query.token as string)}` : ""}`);
});

// El QR en logs de texto (Railway, etc.) sale distorsionado o cambia antes de
// poder escanearlo -- esta pagina sirve el QR como imagen real y se
// autorrefresca, asi se puede abrir en el navegador y escanear normal.
app.get("/qr", (req, res) => {
  if (!requireAdminToken(req, res)) return;
  if (phoneNumberId) {
    res.send("<h1>Ya conectado</h1><p>El bot ya tiene una sesion activa de WhatsApp.</p>");
    return;
  }
  if (!latestQr) {
    res.send("<meta http-equiv='refresh' content='3'><p>Esperando que se genere el QR...</p>");
    return;
  }
  QRCode.toDataURL(latestQr, { width: 320 }, (err, dataUrl) => {
    if (err || !dataUrl) {
      res.status(500).send("No se pudo generar la imagen del QR.");
      return;
    }
    res.send(`<meta http-equiv="refresh" content="20">
      <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;">
        <h2>Escanea este QR con WhatsApp</h2>
        <img src="${dataUrl}" width="320" height="320" />
        <p>Esta pagina se refresca solo cada 20s (el QR expira y se genera uno nuevo).</p>
      </body>`);
  });
});

app.listen(port, () => console.log(`Health check escuchando en puerto ${port}${clientId ? ` (clientId=${clientId})` : ""}`));

// Chrome deja archivos de "lock" en el perfil para que dos procesos no usen
// la misma sesion a la vez. En Docker con volumen persistente, si el
// contenedor anterior crasheo o Railway lo reinicio, el lock queda en el
// volumen pero referencia un hostname de contenedor que ya no existe -- el
// Chrome nuevo lo ve y se niega a arrancar pensando que "otra maquina" sigue
// usando el perfil. Como aqui solo corre una instancia a la vez, es seguro
// borrar el lock viejo antes de arrancar.
function clearStaleChromiumLock(): void {
  const dataPath = path.resolve("./.wwebjs_auth");
  const sessionDir = path.join(dataPath, clientId ? `session-${clientId}` : "session");
  for (const file of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.unlinkSync(path.join(sessionDir, file));
      console.log(`Lock de Chromium viejo eliminado: ${file}`);
    } catch {
      // No existia (primer arranque) o no se pudo borrar -- no es problema.
    }
  }
}
clearStaleChromiumLock();

// NOTA: aqui hubo un webVersionCache fijo a una version pineada de
// wa-version (para evitar "X is not a function" al enviar con la version en
// vivo). Pero en Railway esa version pineada hace crashear Client.inject()
// con "Execution context was destroyed" -- WhatsApp parece haber cambiado
// algo del lado del servidor que ya no es compatible con ese snapshot
// estatico. Se quita el pin y se usa la version en vivo (comportamiento por
// defecto de whatsapp-web.js); si vuelve a aparecer el error de envio, se
// puede volver a pinear a una version mas reciente de wa-version.
const whatsappClient = new Client({
  authStrategy: new LocalAuth({ clientId }),
  puppeteer: {
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // /dev/shm viene limitado a 64MB por defecto en Docker; Chrome se
      // queda sin espacio ahi justo al inyectar el script de WhatsApp Web y
      // el contexto de ejecucion se destruye a medio camino. Esto le dice a
      // Chrome que use /tmp en vez de /dev/shm para memoria compartida.
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    // En produccion (Docker/Railway) usamos el Chromium del sistema en vez
    // del que descarga Puppeteer, ver Dockerfile. En local, sin esta
    // variable, usa el Chromium que ya descargo Puppeteer por su cuenta.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
  ...(process.env.WHATSAPP_WEB_VERSION_URL
    ? { webVersionCache: { type: "remote" as const, remotePath: process.env.WHATSAPP_WEB_VERSION_URL } }
    : {}),
});

whatsappClient.on("qr", (qr: string) => {
  latestQr = qr;
  qrcodeTerminal.generate(qr, { small: true });
  console.log("Escanea este QR con WhatsApp en tu telefono (o abre /qr en el navegador si estas en un servidor).");
});

whatsappClient.on("ready", () => {
  phoneNumberId = whatsappClient.info.wid.user;
  latestQr = null;
  console.log(`WhatsApp listo${clientId ? ` (clientId=${clientId})` : ""}. Numero del bot: ${phoneNumberId}`);
  console.log('Verifica que ese mismo numero este en RestoPOS -> Configuracion -> "Bot de WhatsApp".');
});

whatsappClient.on("message", async (msg: Message) => {
  if (msg.fromMe || !phoneNumberId || isPaused) return;

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

function memorySnapshot(): string {
  return `memFree=${(os.freemem() / 1024 / 1024).toFixed(0)}MB de memTotal=${(os.totalmem() / 1024 / 1024).toFixed(0)}MB`;
}

let initAttempts = 0;

// whatsappClient.initialize() puede fallar (crash de Chromium al inyectar el
// script de WhatsApp Web). Sin este catch, un rechazo de promesa sin manejar
// tumba TODO el proceso (Node 15+) y Railway reinicia el contenedor entero
// desde cero -- mas lento, y se pierde la chance de loguear el estado exacto
// (memoria libre) en el momento del crash. Aqui se loguea ese diagnostico y
// se reintenta in-process unas pocas veces antes de rendirse.
function startWhatsApp(): void {
  initAttempts += 1;
  console.log(`[diagnostico] Intento de conexion #${initAttempts}. ${memorySnapshot()}`);
  whatsappClient.initialize().catch(async (error) => {
    console.error(`[diagnostico] Fallo whatsappClient.initialize(). ${memorySnapshot()}`);
    console.error(error);
    // Cierra el browser a medio lanzar (si quedo alguno) antes de reintentar,
    // para no acumular procesos de Chrome zombie en cada intento.
    await whatsappClient.destroy().catch(() => {});
    clearStaleChromiumLock();
    if (initAttempts < 3) {
      console.log("Reintentando en 10s...");
      setTimeout(startWhatsApp, 10_000);
    } else {
      console.error("Se agotaron los reintentos in-process. Termina el proceso para que Railway reinicie el contenedor.");
      process.exit(1);
    }
  });
}

startWhatsApp();

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
