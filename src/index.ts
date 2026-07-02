import "dotenv/config";
import crypto from "crypto";
import os from "os";
import express from "express";

import { interpretMessage } from "./gemini";
import {
  botPauseConversation,
  botSaveMessage,
  botUpsertConversation,
  type ConvInfo,
  createHandoff,
  createOrder,
  createPaymentLink,
  getMenu,
  getOrderInvoicePdf,
  getPaymentLinkForCharge,
  notifyNewOrder,
  setPaymentLinkSession,
  supabaseUrl,
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
import { downloadMedia, sendWhatsAppDocument, sendWhatsAppText, uploadMedia } from "./metaWhatsapp";
import { IncomingMessage, MenuSnapshot, OrderItem } from "./types";
import { startEcfStatusPoller } from "./ecf/ecfPoller";

console.log(
  `[diagnostico] Node ${process.version} arch=${process.arch} cpus=${os.cpus().length} ` +
    `memTotal=${(os.totalmem() / 1024 / 1024).toFixed(0)}MB memFree=${(os.freemem() / 1024 / 1024).toFixed(0)}MB`,
);

const port = Number(process.env.PORT) || 5000;
const verifyToken = process.env.META_VERIFY_TOKEN;
const appSecret = process.env.META_APP_SECRET;

if (!verifyToken) {
  throw new Error("Falta META_VERIFY_TOKEN en el .env (debe coincidir con el 'Verify token' que pongas en Meta).");
}
if (!appSecret) {
  console.warn(
    "META_APP_SECRET no esta configurado: NO se valida la firma de los webhooks entrantes. " +
      "Configuralo antes de produccion (ver .env.example).",
  );
}

// Pausa logica: el proceso sigue corriendo y el webhook sigue respondiendo
// 200 a Meta (si no, Meta reintenta y luego puede desactivar el webhook),
// pero el bot ignora el contenido del mensaje mientras esta en true. Es la
// forma rapida de "apagarlo" sin tocar el VPS ni RestoPOS.
let isPaused = false;

const adminToken = process.env.BOT_ADMIN_TOKEN;
if (!adminToken) {
  console.warn(
    "BOT_ADMIN_TOKEN no esta configurado: /health y /control quedan PUBLICOS sin clave. " +
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
// Guardamos el body crudo para poder validar la firma X-Hub-Signature-256
// antes de confiar en el JSON ya parseado.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get("/health", (req, res) => {
  if (!requireAdminToken(req, res)) return;
  res.json({ ok: true, paused: isPaused });
});

// Panel simple para pausar/reanudar el bot con un click, sin redeploy.
app.get("/control", (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const token = (req.query.token as string | undefined) || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  res.send(`
    <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;gap:14px;">
      <h2>Bot de WhatsApp: ${isPaused ? "PAUSADO" : "ACTIVO"}</h2>
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

// Genera y envía un e-CF a la DGII para una orden ya pagada.
// Llamado desde Restpo (POS) cuando el cajero cierra la orden.
// Header requerido: x-admin-token
app.post("/internal/generate-ecf", async (req, res) => {
  const provided = req.header("x-admin-token");
  if (!adminToken || provided !== adminToken) {
    res.status(403).send("Forbidden");
    return;
  }
  const { generateAndSendEcf } = await import("./ecf/ecfService");
  const body = req.body ?? {};
  if (!body.restaurantId || !body.orderId) {
    res.status(400).json({ error: "Faltan restaurantId y orderId." });
    return;
  }
  try {
    const result = await generateAndSendEcf(body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// Genera una E34 (Nota de Crédito) para anular un comprobante ya emitido.
// Llamado desde Restpo cuando un admin cancela una orden que tenía e-CF.
// Header requerido: x-admin-token
app.post("/internal/generate-ecf-credit-note", async (req, res) => {
  const provided = req.header("x-admin-token");
  if (!adminToken || provided !== adminToken) {
    res.status(403).send("Forbidden");
    return;
  }
  const { generateCreditNote } = await import("./ecf/ecfService");
  const body = req.body ?? {};
  if (!body.restaurantId || !body.orderId || !body.originalEncf || !body.originalDate) {
    res.status(400).json({ error: "Faltan restaurantId, orderId, originalEncf u originalDate." });
    return;
  }
  try {
    const result = await generateCreditNote(body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// Llamado por la Edge Function cardnet-payment-return justo despues de
// verificar un pago con tarjeta y crear la orden ya pagada -- el bot solo
// se encarga de avisarle al cliente por WhatsApp. Protegido con el mismo
// BOT_ADMIN_TOKEN que /health y /control (header x-admin-token).
app.post("/internal/notify-payment", (req, res) => {
  const provided = req.header("x-admin-token");
  if (!adminToken || provided !== adminToken) {
    res.status(403).send("Forbidden");
    return;
  }
  const { phoneNumberId, to, orderId, orderNumber, total } = req.body ?? {};
  if (!phoneNumberId || !to || !orderId) {
    res.status(400).json({ error: "Faltan phoneNumberId, to u orderId." });
    return;
  }
  res.json({ ok: true });
  notifyCardPaymentConfirmed(phoneNumberId, to, orderId, orderNumber, total).catch((err) => {
    console.error("Fallo notifyCardPaymentConfirmed:", err);
  });
});

async function notifyCardPaymentConfirmed(
  phoneNumberId: string,
  to: string,
  orderId: string,
  orderNumber: string | undefined,
  total: number | undefined,
): Promise<void> {
  const totalText =
    typeof total === "number"
      ? new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(total)
      : "";
  const replyText = `Pago recibido! Tu pedido ${orderNumber ?? orderId} quedo registrado y pagado${
    totalText ? ` (${totalText})` : ""
  }. Gracias por tu compra.`;
  const state = await getState(to);
  recordBotMessage(state, replyText);
  await saveState(to, state);
  await safeReply(phoneNumberId, to, replyText);
  await safeSendInvoice(phoneNumberId, to, orderId);
}

// Pagina de pago que el bot manda por WhatsApp. Corre en el servidor Express
// (no en una Edge Function de Supabase) porque Supabase inyecta una
// Content-Security-Policy "sandbox" que bloquea cualquier script JS -- y
// necesitamos JS para auto-enviar el formulario a Cardnet.
app.get("/pay/:linkId", async (req, res) => {
  const { linkId } = req.params;
  const link = await getPaymentLinkForCharge(linkId);

  if (!link) {
    res.status(400).send(`<!doctype html><html><head><meta charset="utf-8"><title>Pago no valido</title></head>
    <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
      <h2>Este link de pago ya no es valido</h2>
      <p>Puede que ya fue usado o expiro. Vuelve a WhatsApp e intenta de nuevo.</p>
    </body></html>`);
    return;
  }
  if (!link.merchantNumber || !link.privateKey) {
    res.status(400).send(`<!doctype html><html><head><meta charset="utf-8"><title>Pago no disponible</title></head>
    <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
      <h2>Pago con tarjeta no disponible</h2><p>El restaurante no tiene el pago con tarjeta configurado.</p>
    </body></html>`);
    return;
  }

  const env = link.env === "production" ? "production" : "test";
  const sessionsUrl = env === "production"
    ? "https://ecommerce.cardnet.com.do/sessions"
    : "https://labservicios.cardnet.com.do/sessions";
  const authorizeUrl = env === "production"
    ? "https://ecommerce.cardnet.com.do/authorize"
    : "https://labservicios.cardnet.com.do/authorize";

  const botPublicUrl = process.env.BOT_PUBLIC_URL || `https://overrun-garage-paparazzi.ngrok-free.dev`;
  const returnBase = supabaseUrl
    ? `${supabaseUrl}/functions/v1/cardnet-payment-return`
    : `${botPublicUrl}/cardnet-return`;

  try {
    const sessRes = await fetch(sessionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${link.privateKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        TransactionType: "0200",
        CurrencyCode: "214",
        MerchantNumber: link.merchantNumber,
        MerchantTerminal: link.merchantTerminal,
        MerchantCategory: link.merchantCategory || "7997",
        MerchantName: String(link.restaurantName || "RestoPOS").slice(0, 40),
        Amount: String(Math.round(Number(link.total) * 100)),
        Tax: String(Math.round(Number(link.taxTotal || 0) * 100)),
        OrdenId: String(linkId).replace(/-/g, "").slice(0, 20),
        TransactionId: String(Date.now()).slice(-6),
        PageLanguaje: "ESP",
        ReturnUrl: `${returnBase}?link_id=${linkId}`,
        CancelUrl: `${returnBase}?link_id=${linkId}&cancelled=1`,
      }),
    });

    const sessData = (await sessRes.json()) as Record<string, string>;
    if (!sessRes.ok || !sessData.SESSION) {
      console.error("[pay-page] Cardnet /sessions fallo:", sessRes.status, JSON.stringify(sessData));
      res.status(502).send(`<!doctype html><html><head><meta charset="utf-8"><title>Error de pago</title></head>
      <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
        <h2>No se pudo conectar con la pasarela de pago</h2>
        <p>Intenta de nuevo en unos minutos o contáctanos para pagar de otra forma.</p>
      </body></html>`);
      return;
    }

    await setPaymentLinkSession(linkId, sessData.SESSION, sessData["session-key"] || "");

    res.send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirigiendo a pago seguro...</title></head>
  <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
    <p>Redirigiendo a la página segura de pago de Cardnet...</p>
    <form id="f" method="POST" action="${authorizeUrl}">
      <input type="hidden" name="SESSION" value="${sessData.SESSION}" />
      <input type="hidden" name="PageLanguaje" value="ESP" />
      <noscript>
        <button type="submit" style="font-size:18px;padding:10px 24px;margin-top:20px;">
          Ir a pagar con tarjeta
        </button>
      </noscript>
    </form>
    <script>document.getElementById("f").submit();</script>
  </body>
</html>`);
  } catch (err) {
    console.error("[pay-page] Error inesperado:", err);
    res.status(500).send(`<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head>
    <body style="font-family:sans-serif;text-align:center;margin-top:80px;">
      <h2>Error inesperado</h2><p>Intenta de nuevo en un momento.</p>
    </body></html>`);
  }
});

// Meta hace este GET una sola vez (y cada vez que reconfigures el webhook)
// para confirmar que el dueno del endpoint es quien dice ser.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === verifyToken) {
    console.log("Verificacion de webhook de Meta OK.");
    res.status(200).send(challenge);
  } else {
    console.warn("Verificacion de webhook de Meta fallo (token no coincide).");
    res.sendStatus(403);
  }
});

function isValidSignature(req: express.Request): boolean {
  if (!appSecret) return true;
  const signature = req.header("x-hub-signature-256");
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/webhook", (req, res) => {
  // Meta espera un 200 rapido o reintenta el mismo webhook varias veces y
  // eventualmente lo marca como no saludable. Confirmamos de inmediato y
  // procesamos el mensaje despues, sin bloquear la respuesta.
  res.sendStatus(200);

  if (!isValidSignature(req)) {
    console.warn("[diagnostico] Firma de webhook invalida; payload ignorado.");
    return;
  }

  handleWebhookPayload(req.body).catch((error) => {
    console.error("Error procesando webhook de Meta:", error);
  });
});

app.listen(port, () => {
  console.log(`Bot escuchando en puerto ${port}`);
  startEcfStatusPoller();
});

type MetaWebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          from: string;
          type: string;
          text?: { body?: string };
          audio?: { id?: string };
        }>;
      };
    }>;
  }>;
};

async function handleWebhookPayload(body: MetaWebhookBody): Promise<void> {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const phoneNumberId = value?.metadata?.phone_number_id;
  const message = value?.messages?.[0];
  // El mismo webhook tambien manda actualizaciones de estado (sent/delivered/
  // read) sin "messages" -- no son mensajes de un cliente, se ignoran.
  if (!phoneNumberId || !message || isPaused) return;

  const from = message.from;
  console.log(`[diagnostico] Mensaje entrante. from=${from} type=${message.type} phoneNumberId=${phoneNumberId}`);

  if (await isRateLimited(from)) {
    console.warn(`Rate limit alcanzado para ${from}; mensaje ignorado.`);
    return;
  }

  let incoming: IncomingMessage;
  let messageLabel: string;
  if (message.type === "text") {
    const text = (message.text?.body || "").trim();
    if (!text) return;
    incoming = { kind: "text", text };
    messageLabel = text;
  } else if (message.type === "audio" && message.audio?.id) {
    const media = await downloadMedia(message.audio.id);
    if (!media) {
      console.warn("No se pudo descargar la nota de voz; mensaje ignorado.");
      return;
    }
    incoming = { kind: "audio", mimeType: media.mimeType, data: media.base64 };
    messageLabel = "[nota de voz]";
  } else {
    // Imagenes, stickers, ubicacion, etc. se ignoran en v1.
    return;
  }

  try {
    await handleIncomingMessage(phoneNumberId, from, incoming, messageLabel);
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    await safeReply(phoneNumberId, from, "Disculpa, tuvimos un problema tecnico. Intenta de nuevo en un momento.");
  }
}

const HUMAN_KEYWORDS = [
  "hablar con persona", "hablar con alguien", "quiero un agente",
  "atencion humana", "soporte humano", "representante", "supervisor",
  "necesito ayuda de verdad", "no me entiende",
];

async function handleIncomingMessage(
  phoneNumberId: string,
  from: string,
  incoming: IncomingMessage,
  messageLabel: string,
): Promise<void> {
  const menu = await getMenu(phoneNumberId);
  if (!menu) {
    console.warn(`Bot de WhatsApp deshabilitado para el numero ${phoneNumberId}; mensaje ignorado.`);
    return;
  }

  // --- Chat panel: registra conversacion y verifica si el bot esta pausado ---
  const conv = await botUpsertConversation(phoneNumberId, from).catch(() => null) as ConvInfo | null;
  if (conv) {
    botSaveMessage(conv.id, conv.restaurantId, "inbound", "customer", messageLabel).catch(() => {});
    if (conv.botPaused) {
      console.log(`[chat] Conversacion ${from} en modo humano; mensaje guardado, IA no responde.`);
      return;
    }
  }

  // Deteccion explicita de solicitud de humano (antes de llamar a Gemini)
  if (
    incoming.kind === "text" &&
    HUMAN_KEYWORDS.some((k) => incoming.text.toLowerCase().includes(k))
  ) {
    const replyText = "Entendido! Te conecto con uno de nuestros agentes. En un momento te atienden. 👋";
    const state = await getState(from);
    recordBotMessage(state, replyText);
    await saveState(from, state);
    if (conv) {
      await botPauseConversation(conv.id, "Cliente solicito atencion humana").catch(() => {});
      botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
    }
    await safeReply(phoneNumberId, from, replyText);
    return;
  }
  // --------------------------------------------------------------------------

  const state = await getState(from);
  recordCustomerMessage(state, messageLabel);
  const systemPrompt = buildSystemPrompt(menu, state);

  const llmResult = await interpretMessage(systemPrompt, incoming);
  const messageExcerpt = llmResult?.transcript || messageLabel;

  if (!llmResult) {
    const shouldHandoff = recordFailedAttempt(state);
    const replyText = shouldHandoff
      ? "Disculpa, no logro entender bien tu pedido. Ya avise a alguien del negocio para que te atienda en breve."
      : "Disculpa, no entendi bien eso. Puedes repetir tu pedido con mas detalle?";

    recordBotMessage(state, replyText);
    await saveState(from, state);
    if (shouldHandoff) {
      await createHandoff(phoneNumberId, from, state.profile.name, "no_entendido", messageExcerpt);
      if (conv) await botPauseConversation(conv.id, "no_entendido").catch(() => {});
    }
    await safeReply(phoneNumberId, from, replyText);
    if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
    return;
  }

  if (llmResult.intent !== "handoff") {
    resetFailedAttempts(state);
  }
  updateProfile(state, llmResult.customerName, llmResult.customerEmail);
  updateDelivery(state, llmResult.deliveryType, llmResult.deliveryAddress);
  recordBotMessage(state, llmResult.replyText);
  await saveState(from, state);

  const profile = state.profile;

  if (llmResult.intent === "order") {
    await handleOrderIntent(phoneNumberId, from, profile.name, profile.email,
      llmResult.items, menu, state.deliveryType, state.deliveryAddress, conv);
    return;
  }

  if (llmResult.intent === "card_payment") {
    await handleCardPaymentIntent(phoneNumberId, from, profile.name, profile.email,
      llmResult.items, state.deliveryType, state.deliveryAddress, conv);
    return;
  }

  if (llmResult.intent === "handoff") {
    await createHandoff(phoneNumberId, from, profile.name, llmResult.reason, messageExcerpt);
    if (conv) await botPauseConversation(conv.id, llmResult.reason || "handoff").catch(() => {});
    await safeReply(phoneNumberId, from, llmResult.replyText);
    if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", llmResult.replyText).catch(() => {});
    return;
  }

  await safeReply(phoneNumberId, from, llmResult.replyText);
  if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", llmResult.replyText).catch(() => {});
}

async function handleOrderIntent(
  phoneNumberId: string,
  from: string,
  customerName: string,
  customerEmail: string,
  items: OrderItem[],
  menu: MenuSnapshot,
  deliveryType: string,
  deliveryAddress: string,
  conv: ConvInfo | null = null,
): Promise<void> {
  const customer = await upsertCustomer(phoneNumberId, customerName, customerEmail);
  if (!customer) {
    const replyText =
      "No pude registrar tus datos de contacto. Puedes confirmarme de nuevo tu nombre completo y un correo electronico valido?";
    const state = await getState(from);
    recordBotMessage(state, replyText);
    await saveState(from, state);
    await safeReply(phoneNumberId, from, replyText);
    return;
  }

  const order = await createOrder(
    phoneNumberId,
    from,
    customerName,
    items,
    customer.customerId,
    deliveryType,
    deliveryAddress,
  );
  if (!order) {
    const replyText =
      "No pude registrar tu pedido tal como lo escribiste. Puedes confirmarme de nuevo, uno por uno, los productos y cantidades que deseas?";
    const state = await getState(from);
    recordBotMessage(state, replyText);
    await saveState(from, state);
    await safeReply(phoneNumberId, from, replyText);
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
      customerPhone: from,
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
    deliveryType === "delivery" ? `Entrega a domicilio: ${deliveryAddress}` : "Para retirar en el restaurante";

  const replyText = `Listo! Tu pedido ${order.orderNumber} quedo registrado:\n${itemLines}\n\n${deliveryLine}\nTotal: ${total}\n\nGracias por tu compra en ${menu.restaurant.name}.`;
  const state = await getState(from);
  recordBotMessage(state, replyText);
  await saveState(from, state);
  await safeReply(phoneNumberId, from, replyText);
  if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
  await safeSendInvoice(phoneNumberId, from, order.orderId);
}

// Manda la factura en PDF justo despues de confirmar el pedido (misma
// conversacion, dentro de la ventana de 24h gratis de WhatsApp). No bloquea
// ni rompe el flujo si falla -- el pedido y la confirmacion de texto ya
// quedaron bien de todos modos.
async function safeSendInvoice(phoneNumberId: string, to: string, orderId: string): Promise<void> {
  try {
    const invoice = await getOrderInvoicePdf(phoneNumberId, orderId);
    if (!invoice) return;
    const mediaId = await uploadMedia(phoneNumberId, invoice.bytes, "application/pdf", invoice.filename);
    await sendWhatsAppDocument(phoneNumberId, to, mediaId, invoice.filename, "Aqui tienes tu factura.");
  } catch (err) {
    console.error("Fallo al mandar la factura en PDF:", err);
  }
}

async function handleCardPaymentIntent(
  phoneNumberId: string,
  from: string,
  customerName: string,
  customerEmail: string,
  items: OrderItem[],
  deliveryType: string,
  deliveryAddress: string,
  conv: ConvInfo | null = null,
): Promise<void> {
  const link = await createPaymentLink(phoneNumberId, from, customerName, customerEmail, items, deliveryType, deliveryAddress);
  if (!link) {
    const replyText =
      "No pude generar el link de pago. Puedes confirmarme de nuevo los productos y cantidades, o prefieres pagar en efectivo?";
    const state = await getState(from);
    recordBotMessage(state, replyText);
    await saveState(from, state);
    await safeReply(phoneNumberId, from, replyText);
    return;
  }

  const botPublicUrl = process.env.BOT_PUBLIC_URL || "https://overrun-garage-paparazzi.ngrok-free.dev";
  const payUrl = `${botPublicUrl}/pay/${link.linkId}`;
  const total = new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(
    link.total,
  );
  const replyText = `Perfecto! Aqui esta tu link de pago seguro por ${total}:\n${payUrl}\n\nEn cuanto completes el pago te confirmo tu pedido aqui mismo.`;
  const state = await getState(from);
  recordBotMessage(state, replyText);
  await saveState(from, state);
  await safeReply(phoneNumberId, from, replyText);
  if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
}

async function safeReply(phoneNumberId: string, to: string, text: string): Promise<void> {
  try {
    await sendWhatsAppText(phoneNumberId, to, text);
  } catch (err) {
    console.error("Fallo al enviar mensaje de WhatsApp:", err);
  }
}
