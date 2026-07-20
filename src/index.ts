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
  type WhatsappIntegrationCredentials,
  createHandoff,
  createOrder,
  createPaymentLink,
  getCustomerByPhone,
  getMenu,
  getOrderInvoicePdf,
  getPaymentLinkForCharge,
  getWhatsappIntegration,
  getWhatsappIntegrationByPhoneNumber,
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
  setCustomerProfile,
  updateDelivery,
  updateProfile,
} from "./memory";
import { isRateLimited } from "./rateLimiter";
import { downloadMedia, sendWhatsAppDocument, sendWhatsAppText, uploadMedia } from "./metaWhatsapp";
import { logPlatformEvent, maskPhone } from "./logger";
import { recordIntegrationSendError } from "./supabaseClient";
import { analyzeRestaurantConversations } from "./insights";
import { ConversationState, IncomingMessage, MenuSnapshot, OrderItem } from "./types";
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
      "Configuralo antes de producción (ver .env.example).",
  );
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.WHATSAPP_CREDENTIALS_KEY) {
  console.warn(
    "Falta SUPABASE_SERVICE_ROLE_KEY y/o WHATSAPP_CREDENTIALS_KEY: las rutas multi-cliente " +
      "/webhook/meta/:integrationId responderan 404 porque no se pueden leer las credenciales " +
      "cifradas de whatsapp_integrations. Solo funcionara el /webhook legacy con el token global.",
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

type RuntimeWhatsAppCredentials = Pick<WhatsappIntegrationCredentials, "accessToken" | "appSecret" | "verifyTokenHash" | "phoneNumberId">;

function hashVerifyToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function verifyIntegrationToken(credentials: RuntimeWhatsAppCredentials, token: unknown): boolean {
  return typeof token === "string" && hashVerifyToken(token) === credentials.verifyTokenHash;
}

async function resolveCredentialsForPhone(
  phoneNumberId: string,
  credentials?: RuntimeWhatsAppCredentials | null,
): Promise<RuntimeWhatsAppCredentials | null> {
  if (credentials?.phoneNumberId === phoneNumberId) return credentials;
  return getWhatsappIntegrationByPhoneNumber(phoneNumberId).catch((error) => {
    console.warn(`No se pudieron resolver credenciales WhatsApp para ${phoneNumberId}:`, error?.message || error);
    return null;
  });
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

// Healthcheck publico para monitoreo externo (UptimeRobot). Sin datos
// sensibles: solo confirma que el proceso responde.
app.get("/up", (_req, res) => {
  res.status(200).send("ok");
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

// Fase 3 del bot inteligente: analiza las conversaciones recientes de un
// restaurante y deja sugerencias 'pending' en bot_suggestions para que el
// admin las apruebe desde Restpo. Lo dispara la Edge Function
// analyze-bot-conversations (boton "Analizar conversaciones" del panel).
// Header requerido: x-admin-token
app.post("/internal/analyze-conversations", async (req, res) => {
  const provided = req.header("x-admin-token");
  if (!adminToken || provided !== adminToken) {
    res.status(403).send("Forbidden");
    return;
  }
  const restaurantId = (req.body ?? {}).restaurantId as string | undefined;
  if (!restaurantId) {
    res.status(400).json({ error: "Falta restaurantId." });
    return;
  }
  try {
    const result = await analyzeRestaurantConversations(restaurantId);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logPlatformEvent("error", "bot.analysis_failed", `Fallo el analisis de conversaciones: ${message.slice(0, 300)}`, restaurantId);
    res.status(500).json({ error: message });
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
  const credentials = await resolveCredentialsForPhone(phoneNumberId);
  const state = await getState(phoneNumberId, to);
  recordBotMessage(state, replyText);
  await saveState(phoneNumberId, to, state);
  await safeReply(phoneNumberId, to, replyText, credentials);
  await safeSendInvoice(phoneNumberId, to, orderId, credentials);
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

app.get("/webhook/meta/:integrationId", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  try {
    const credentials = await getWhatsappIntegration(req.params.integrationId);
    if (mode === "subscribe" && credentials && verifyIntegrationToken(credentials, token)) {
      console.log(`Verificacion de webhook Meta OK para integracion ${req.params.integrationId}.`);
      res.status(200).send(challenge);
      return;
    }
  } catch (error) {
    console.warn("No se pudo verificar integracion WhatsApp:", error);
  }
  console.warn(`Verificacion de webhook Meta fallo para integracion ${req.params.integrationId}.`);
  res.sendStatus(403);
});

app.post("/webhook/meta/:integrationId", async (req, res) => {
  let credentials: WhatsappIntegrationCredentials | null = null;
  try {
    credentials = await getWhatsappIntegration(req.params.integrationId);
  } catch (error) {
    console.error("No se pudieron cargar credenciales WhatsApp:", error);
  }

  if (!credentials) {
    logPlatformEvent("warn", "webhook.integration_not_found", `Webhook POST para integracion desconocida o inactiva: ${req.params.integrationId}.`, null, {
      integrationId: req.params.integrationId,
    });
    res.sendStatus(404);
    return;
  }

  res.sendStatus(200);

  if (!isValidSignature(req, credentials.appSecret)) {
    logPlatformEvent("warn", "webhook.invalid_signature", `Firma X-Hub-Signature-256 invalida para la integracion ${req.params.integrationId}; payload ignorado (posible app secret desactualizado o request falso).`, credentials.restaurantId ?? null, {
      integrationId: req.params.integrationId,
    });
    return;
  }

  handleWebhookPayload(req.body, credentials).catch((error) => {
    console.error("Error procesando webhook de Meta:", error);
  });
});

function isValidSignature(req: express.Request, secretOverride?: string): boolean {
  const secret = secretOverride || appSecret;
  if (!secret) return true;
  const signature = req.header("x-hub-signature-256");
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
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

// Solo localhost: todo el trafico entra por el reverse proxy (Caddy). Se
// puede abrir con BIND_HOST=0.0.0.0 (p. ej. en Docker/Railway).
const bindHost = process.env.BIND_HOST || "127.0.0.1";
app.listen(port, bindHost, () => {
  console.log(`Bot escuchando en ${bindHost}:${port}`);
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
          location?: { latitude?: number; longitude?: number; name?: string; address?: string };
        }>;
      };
    }>;
  }>;
};

async function handleWebhookPayload(body: MetaWebhookBody, credentials?: RuntimeWhatsAppCredentials | null): Promise<void> {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const phoneNumberId = value?.metadata?.phone_number_id;
  const message = value?.messages?.[0];
  // El mismo webhook tambien manda actualizaciones de estado (sent/delivered/
  // read) sin "messages" -- no son mensajes de un cliente, se ignoran.
  if (!phoneNumberId || !message || isPaused) return;
  if (credentials && credentials.phoneNumberId !== phoneNumberId) {
    console.warn(
      `[diagnostico] Payload ignorado: phoneNumberId ${phoneNumberId} no coincide con integracion ${credentials.phoneNumberId}.`,
    );
    return;
  }

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
    const media = await downloadMedia(message.audio.id, credentials?.accessToken);
    if (!media) {
      console.warn("No se pudo descargar la nota de voz; mensaje ignorado.");
      return;
    }
    incoming = { kind: "audio", mimeType: media.mimeType, data: media.base64 };
    messageLabel = "[nota de voz]";
  } else if (message.type === "location" && message.location) {
    // Ubicacion compartida por WhatsApp (para delivery). Se arma una linea de
    // direccion + link a Google Maps; entra como texto para que el flujo de
    // pedido la use como direccion y el panel de chat la muestre como pin.
    const loc = message.location;
    const lat = loc.latitude;
    const lng = loc.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    const label = [loc.name, loc.address].filter(Boolean).join(", ").trim();
    const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
    const addressText = label || `Ubicacion compartida (${lat}, ${lng})`;
    incoming = { kind: "text", text: `Mi direccion para el delivery: ${addressText}. Mapa: ${mapsUrl}` };
    messageLabel = `📍 ${addressText} — ${mapsUrl}`;
  } else {
    // Imagenes, stickers, etc. se ignoran en v1.
    return;
  }

  try {
    await handleIncomingMessage(phoneNumberId, from, incoming, messageLabel, credentials);
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    await safeReply(phoneNumberId, from, "Disculpa, tuvimos un problema tecnico. Intenta de nuevo en un momento.", credentials);
  }
}

const HUMAN_KEYWORDS = [
  "hablar con persona", "hablar con alguien", "quiero un agente",
  "atencion humana", "soporte humano", "representante", "supervisor",
  "necesito ayuda de verdad", "no me entiende",
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ORDER_HINTS = [
  "pedir", "pedido", "ordenar", "orden", "comprar", "quiero", "dame",
  "mandame", "envia", "delivery", "recoger", "pickup", "pagar", "tarjeta", "efectivo",
];

function textFromIncoming(incoming: IncomingMessage): string {
  return incoming.kind === "text" ? incoming.text.trim() : "";
}

function looksLikeOrderRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return ORDER_HINTS.some((hint) => normalized.includes(hint));
}

async function replyAndStore(
  phoneNumberId: string,
  from: string,
  state: ConversationState,
  replyText: string,
  conv: ConvInfo | null,
  credentials?: RuntimeWhatsAppCredentials | null,
): Promise<void> {
  recordBotMessage(state, replyText);
  await saveState(phoneNumberId, from, state);
  await safeReply(phoneNumberId, from, replyText, credentials);
  if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
}

// Resuelve al cliente por telefono (solo nombre; el correo ya no se pide).
// Deja el perfil listo si existe y devuelve true cuando ya hay nombre.
async function resolveCustomer(
  phoneNumberId: string,
  from: string,
  state: ConversationState,
): Promise<boolean> {
  if (state.profile.customerId && state.profile.name) return true;
  const customer = await getCustomerByPhone(phoneNumberId, from);
  if (customer) {
    setCustomerProfile(state, customer);
    if (!customer.missingName) return true;
  }
  state.profile.phone = from;
  return Boolean(state.profile.name);
}

async function handleIncomingMessage(
  phoneNumberId: string,
  from: string,
  incoming: IncomingMessage,
  messageLabel: string,
  credentials?: RuntimeWhatsAppCredentials | null,
): Promise<void> {
  const menu = await getMenu(phoneNumberId);
  if (!menu) {
    logPlatformEvent(
      "warn",
      "bot.menu_unresolved",
      `Mensaje ignorado: no se resolvio menu/restaurante para el numero ${phoneNumberId} (bot deshabilitado o numero sin registrar).`,
      null,
      { phoneNumberId, from: maskPhone(from) },
    );
    return;
  }

  // --- Chat panel: registra conversacion y verifica si el bot esta pausado ---
  const conv = await botUpsertConversation(phoneNumberId, from).catch(() => null) as ConvInfo | null;

  // Para notas de voz se pospone el guardado del mensaje entrante hasta tener
  // la transcripcion de Gemini, asi el panel de chat muestra lo que el
  // cliente DIJO en vez de "[nota de voz]". Si el flujo termina antes de
  // llamar al LLM (bot pausado, identificacion, error), se guarda la
  // etiqueta generica para no perder el mensaje.
  let inboundSaved = false;
  const saveInbound = (content: string) => {
    if (!conv || inboundSaved) return;
    inboundSaved = true;
    botSaveMessage(conv.id, conv.restaurantId, "inbound", "customer", content).catch(() => {});
  };

  if (conv) {
    if (incoming.kind === "text" || conv.botPaused) saveInbound(messageLabel);
    if (conv.botPaused) {
      console.log(`[chat] Conversacion ${from} en modo humano; mensaje guardado, IA no responde.`);
      return;
    }
  }

  const state = await getState(phoneNumberId, from);
  recordCustomerMessage(state, messageLabel);

  // Deteccion explicita de solicitud de humano (antes de llamar a Gemini)
  if (
    incoming.kind === "text" &&
    HUMAN_KEYWORDS.some((k) => incoming.text.toLowerCase().includes(k))
  ) {
    const replyText = "Entendido! Te conecto con uno de nuestros agentes. En un momento te atienden.";
    recordBotMessage(state, replyText);
    await saveState(phoneNumberId, from, state);
    if (conv) {
      await botPauseConversation(conv.id, "Cliente solicito atencion humana").catch(() => {});
      botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
    }
    await safeReply(phoneNumberId, from, replyText, credentials);
    return;
  }

  // El LLM corre PRIMERO (incluso durante la captura de nombre) para tener la
  // transcripcion de la voz y el nombre disponibles antes de decidir nada.
  const systemPrompt = buildSystemPrompt(menu, state);
  const llmResult = await interpretMessage(systemPrompt, incoming);
  const messageExcerpt = llmResult?.transcript || messageLabel;

  // Nota de voz transcrita: se guarda el texto real en el chat y se corrige
  // el historial. Se hace ANTES de la captura para que un nombre dicho por
  // voz tambien se entienda.
  if (incoming.kind === "audio" && llmResult?.transcript) {
    const transcriptText = `🎤 ${llmResult.transcript}`;
    saveInbound(transcriptText);
    const lastCustomerTurn = [...state.history].reverse().find((turn) => turn.role === "customer");
    if (lastCustomerTurn && lastCustomerTurn.text === messageLabel) lastCustomerTurn.text = transcriptText;
  } else {
    saveInbound(messageLabel);
  }

  const effectiveText = incoming.kind === "text" ? incoming.text.trim() : (llmResult?.transcript?.trim() || "");

  // Nombre capturado por el LLM (texto natural o voz) apenas llega.
  if (llmResult?.customerName) updateProfile(state, llmResult.customerName, "");

  // --- Captura de nombre en curso (unico dato que se pide; el correo ya no) ---
  if (state.stage === "ASK_CUSTOMER_NAME") {
    const name = llmResult?.customerName?.trim() || effectiveText;
    if (!name || name.length < 2 || EMAIL_RE.test(name)) {
      await replyAndStore(phoneNumberId, from, state, "Para registrar tu pedido, dime tu nombre completo por favor.", conv, credentials);
      return;
    }
    state.profile.name = name;
    const customer = await upsertCustomer(phoneNumberId, from, name, "");
    if (customer) setCustomerProfile(state, customer);
    state.stage = "CUSTOMER_IDENTIFIED";
    // Retomar el pedido que quedo en espera antes de pedir el nombre.
    if (state.pendingOrder && state.pendingOrder.items.length) {
      const po = state.pendingOrder;
      state.pendingOrder = null;
      await saveState(phoneNumberId, from, state);
      if (po.kind === "card") {
        await handleCardPaymentIntent(phoneNumberId, from, state.profile.name, state.profile.email, po.items, po.deliveryType, po.deliveryAddress, conv, credentials);
      } else {
        await handleOrderIntent(phoneNumberId, from, state.profile.customerId, state.profile.name, state.profile.email, po.items, menu, po.deliveryType, po.deliveryAddress, conv, credentials);
      }
      return;
    }
    await replyAndStore(phoneNumberId, from, state, `Gracias, ${name}. Que deseas ordenar hoy?`, conv, credentials);
    return;
  }

  if (!llmResult) {
    const shouldHandoff = recordFailedAttempt(state);
    // La respuesta de "no entendi" es configurable por el admin del
    // restaurante (fallback_message); el texto de handoff se mantiene fijo
    // porque describe una accion del sistema, no estilo.
    const configuredFallback = menu.botConfig?.fallbackMessage?.trim();
    const replyText = shouldHandoff
      ? "Disculpa, no logro entender bien tu pedido. Ya avise a alguien del negocio para que te atienda en breve."
      : configuredFallback || "Disculpa, no entendi bien eso. Puedes repetir tu pedido con mas detalle?";

    recordBotMessage(state, replyText);
    await saveState(phoneNumberId, from, state);
    if (shouldHandoff) {
      await createHandoff(phoneNumberId, from, state.profile.name, "no_entendido", messageExcerpt);
      if (conv) await botPauseConversation(conv.id, "no_entendido").catch(() => {});
    }
    await safeReply(phoneNumberId, from, replyText, credentials);
    if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
    return;
  }

  if (llmResult.intent !== "handoff") {
    resetFailedAttempts(state);
  }
  updateDelivery(state, llmResult.deliveryType, llmResult.deliveryAddress);
  recordBotMessage(state, llmResult.replyText);
  await saveState(phoneNumberId, from, state);

  const profile = state.profile;

  if (llmResult.intent === "order") {
    await resolveCustomer(phoneNumberId, from, state);
    if (!state.profile.name) {
      // Falta el nombre: se guarda el pedido y se pide el nombre (solo eso).
      state.pendingOrder = { kind: "order", items: llmResult.items, deliveryType: state.deliveryType, deliveryAddress: state.deliveryAddress };
      state.stage = "ASK_CUSTOMER_NAME";
      await replyAndStore(phoneNumberId, from, state, "Antes de registrar tu pedido, dime tu nombre completo por favor.", conv, credentials);
      return;
    }
    await handleOrderIntent(phoneNumberId, from, state.profile.customerId, state.profile.name, state.profile.email,
      llmResult.items, menu, state.deliveryType, state.deliveryAddress, conv, credentials);
    return;
  }

  if (llmResult.intent === "card_payment") {
    await resolveCustomer(phoneNumberId, from, state);
    if (!state.profile.name) {
      state.pendingOrder = { kind: "card", items: llmResult.items, deliveryType: state.deliveryType, deliveryAddress: state.deliveryAddress };
      state.stage = "ASK_CUSTOMER_NAME";
      await replyAndStore(phoneNumberId, from, state, "Antes de tu pago, dime tu nombre completo por favor.", conv, credentials);
      return;
    }
    await handleCardPaymentIntent(phoneNumberId, from, state.profile.name, state.profile.email,
      llmResult.items, state.deliveryType, state.deliveryAddress, conv, credentials);
    return;
  }

  if (llmResult.intent === "handoff") {
    await createHandoff(phoneNumberId, from, profile.name, llmResult.reason, messageExcerpt);
    if (conv) await botPauseConversation(conv.id, llmResult.reason || "handoff").catch(() => {});
    await safeReply(phoneNumberId, from, llmResult.replyText, credentials);
    if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", llmResult.replyText).catch(() => {});
    return;
  }

  await safeReply(phoneNumberId, from, llmResult.replyText, credentials);
  if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", llmResult.replyText).catch(() => {});
}

async function handleOrderIntent(
  phoneNumberId: string,
  from: string,
  customerId: string,
  customerName: string,
  customerEmail: string,
  items: OrderItem[],
  menu: MenuSnapshot,
  deliveryType: string,
  deliveryAddress: string,
  conv: ConvInfo | null = null,
  credentials?: RuntimeWhatsAppCredentials | null,
): Promise<void> {
  if (!customerId || !customerName) {
    const replyText = "Antes de registrar tu pedido necesito tu nombre completo, por favor.";
    const state = await getState(phoneNumberId, from);
    state.stage = "ASK_CUSTOMER_NAME";
    recordBotMessage(state, replyText);
    await saveState(phoneNumberId, from, state);
    await safeReply(phoneNumberId, from, replyText, credentials);
    return;
  }

  const order = await createOrder(
    phoneNumberId,
    from,
    customerName,
    items,
    customerId,
    deliveryType,
    deliveryAddress,
  );
  if (!order) {
    const replyText =
      "No pude registrar tu pedido tal como lo escribiste. Puedes confirmarme de nuevo, uno por uno, los productos y cantidades que deseas?";
    const state = await getState(phoneNumberId, from);
    recordBotMessage(state, replyText);
    await saveState(phoneNumberId, from, state);
    await safeReply(phoneNumberId, from, replyText, credentials);
    return;
  }

  logPlatformEvent("info", "bot.order_created", `Pedido ${order.orderNumber} creado por el bot (total RD$ ${order.total}).`, menu.restaurant.id, {
    orderNumber: order.orderNumber,
    total: order.total,
    customer: maskPhone(from),
  });

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
  const state = await getState(phoneNumberId, from);
  recordBotMessage(state, replyText);
  await saveState(phoneNumberId, from, state);
  await safeReply(phoneNumberId, from, replyText, credentials);
  if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
  await safeSendInvoice(phoneNumberId, from, order.orderId, credentials);
}

// Manda la factura en PDF justo despues de confirmar el pedido (misma
// conversacion, dentro de la ventana de 24h gratis de WhatsApp). No bloquea
// ni rompe el flujo si falla -- el pedido y la confirmacion de texto ya
// quedaron bien de todos modos.
async function safeSendInvoice(
  phoneNumberId: string,
  to: string,
  orderId: string,
  credentials?: RuntimeWhatsAppCredentials | null,
): Promise<void> {
  try {
    const invoice = await getOrderInvoicePdf(phoneNumberId, orderId);
    if (!invoice) return;
    const mediaId = await uploadMedia(phoneNumberId, invoice.bytes, "application/pdf", invoice.filename, credentials?.accessToken);
    await sendWhatsAppDocument(phoneNumberId, to, mediaId, invoice.filename, "Aqui tienes tu factura.", credentials?.accessToken);
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
  credentials?: RuntimeWhatsAppCredentials | null,
): Promise<void> {
  const link = await createPaymentLink(phoneNumberId, from, customerName, customerEmail, items, deliveryType, deliveryAddress);
  if (!link) {
    const replyText =
      "No pude generar el link de pago. Puedes confirmarme de nuevo los productos y cantidades, o prefieres pagar en efectivo?";
    const state = await getState(phoneNumberId, from);
    recordBotMessage(state, replyText);
    await saveState(phoneNumberId, from, state);
    await safeReply(phoneNumberId, from, replyText, credentials);
    return;
  }

  const botPublicUrl = process.env.BOT_PUBLIC_URL || "https://overrun-garage-paparazzi.ngrok-free.dev";
  const payUrl = `${botPublicUrl}/pay/${link.linkId}`;
  const total = new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(
    link.total,
  );
  const replyText = `Perfecto! Aqui esta tu link de pago seguro por ${total}:\n${payUrl}\n\nEn cuanto completes el pago te confirmo tu pedido aqui mismo.`;
  const state = await getState(phoneNumberId, from);
  recordBotMessage(state, replyText);
  await saveState(phoneNumberId, from, state);
  await safeReply(phoneNumberId, from, replyText, credentials);
  if (conv) botSaveMessage(conv.id, conv.restaurantId, "outbound", "bot", replyText).catch(() => {});
}

async function safeReply(
  phoneNumberId: string,
  to: string,
  text: string,
  credentials?: RuntimeWhatsAppCredentials | null,
): Promise<void> {
  try {
    await sendWhatsAppText(phoneNumberId, to, text, credentials?.accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // El cliente NO recibio la respuesta: deja rastro en el panel de logs y
    // en la integracion (last_error) para que el operador lo vea de inmediato
    // (caso tipico: token de Meta vencido -> 401).
    logPlatformEvent("error", "whatsapp.send_failed", `Fallo el envio de WhatsApp: ${message.slice(0, 300)}`, null, {
      phoneNumberId,
      to: maskPhone(to),
    });
    recordIntegrationSendError(phoneNumberId, message);
  }
}
