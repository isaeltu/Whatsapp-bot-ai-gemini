import { createClient } from "@supabase/supabase-js";
import {
  CreateOrderResult,
  CreatePaymentLinkResult,
  MenuSnapshot,
  OrderItem,
  UpsertCustomerResult,
} from "./types";

export const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const whatsappCredentialsKey = process.env.WHATSAPP_CREDENTIALS_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Faltan SUPABASE_URL / SUPABASE_ANON_KEY en el .env");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
const supabaseService = supabaseServiceRoleKey ? createClient(supabaseUrl, supabaseServiceRoleKey) : null;

export type WhatsappIntegrationCredentials = {
  id: string;
  restaurantId: string;
  providerType: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  accessToken: string;
  appSecret: string;
  verifyTokenHash: string;
  webhookKey: string;
  status: string;
};

function requireCredentialClient() {
  if (!supabaseService || !whatsappCredentialsKey) {
    throw new Error("Faltan SUPABASE_SERVICE_ROLE_KEY / WHATSAPP_CREDENTIALS_KEY para leer credenciales WhatsApp.");
  }
  return { client: supabaseService, key: whatsappCredentialsKey };
}

// Cache en memoria de credenciales ya descifradas: sin esto, CADA mensaje
// entrante paga un round-trip a Postgres con pgp_sym_decrypt. TTL corto para
// que rotar un token o desactivar una integracion surta efecto en ~1 minuto
// sin reiniciar el bot. Los errores NO se cachean (se reintenta al siguiente
// mensaje); un resultado null si se cachea, para no martillar la BD con
// numeros desconocidos.
const CREDENTIALS_CACHE_TTL_MS = 60_000;
const credentialsCache = new Map<string, { value: WhatsappIntegrationCredentials | null; expiresAt: number }>();

async function cachedCredentials(
  cacheKey: string,
  load: () => Promise<WhatsappIntegrationCredentials | null>,
): Promise<WhatsappIntegrationCredentials | null> {
  const hit = credentialsCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await load();
  credentialsCache.set(cacheKey, { value, expiresAt: Date.now() + CREDENTIALS_CACHE_TTL_MS });
  return value;
}

export async function getWhatsappIntegration(integrationId: string): Promise<WhatsappIntegrationCredentials | null> {
  return cachedCredentials(`id:${integrationId}`, async () => {
    const { client, key } = requireCredentialClient();
    const { data, error } = await client.rpc("bot_get_whatsapp_integration", {
      p_integration_id: integrationId,
      p_encryption_key: key,
    });
    if (error) throw error;
    return (data as WhatsappIntegrationCredentials | null) ?? null;
  });
}

export async function getWhatsappIntegrationByPhoneNumber(phoneNumberId: string): Promise<WhatsappIntegrationCredentials | null> {
  return cachedCredentials(`phone:${phoneNumberId}`, async () => {
    const { client, key } = requireCredentialClient();
    const { data, error } = await client.rpc("bot_get_whatsapp_integration_by_phone", {
      p_phone_number_id: phoneNumberId,
      p_encryption_key: key,
    });
    if (error) throw error;
    return (data as WhatsappIntegrationCredentials | null) ?? null;
  });
}

// Las 4 funciones bot_* son las mismas que usaba el flujo de n8n (ver
// supabase/migrations/202606230001_*.sql y 202606230002_*.sql en el repo de
// RestoPOS). Resuelven el restaurante por whatsapp_phone_number_id en vez de
// auth.uid(), por eso estan grant-eadas a anon.

export async function getMenu(phoneNumberId: string): Promise<MenuSnapshot | null> {
  const { data, error } = await supabase.rpc("bot_get_menu", {
    p_phone_number_id: phoneNumberId,
  });
  if (error) throw error;
  return (data as MenuSnapshot | null) ?? null;
}

export async function upsertCustomer(
  phoneNumberId: string,
  fullName: string,
  email: string
): Promise<UpsertCustomerResult | null> {
  const { data, error } = await supabase.rpc("bot_upsert_customer", {
    p_phone_number_id: phoneNumberId,
    p_full_name: fullName,
    p_email: email,
  });
  if (error) {
    console.warn("bot_upsert_customer fallo:", error.message);
    return null;
  }
  return data as UpsertCustomerResult;
}

export async function createOrder(
  phoneNumberId: string,
  customerPhone: string,
  customerName: string,
  items: OrderItem[],
  customerId: string | null,
  deliveryType: string,
  deliveryAddress: string
): Promise<CreateOrderResult | null> {
  const { data, error } = await supabase.rpc("bot_create_order", {
    p_phone_number_id: phoneNumberId,
    p_customer_phone: customerPhone,
    p_customer_name: customerName || null,
    p_items: items,
    p_customer_id: customerId,
    p_delivery_type: deliveryType || null,
    p_delivery_address: deliveryAddress || null,
  });
  if (error) {
    console.warn("bot_create_order fallo:", error.message);
    return null;
  }
  return data as CreateOrderResult;
}

// Crea un link de pago pendiente (NO una orden todavia -- la orden se crea
// recien cuando Cardnet confirma el pago, ver bot_confirm_payment_link en
// la migracion 202606300003).
export async function createPaymentLink(
  phoneNumberId: string,
  customerPhone: string,
  customerName: string,
  customerEmail: string,
  items: OrderItem[],
  deliveryType: string,
  deliveryAddress: string
): Promise<CreatePaymentLinkResult | null> {
  const { data, error } = await supabase.rpc("bot_create_payment_link", {
    p_phone_number_id: phoneNumberId,
    p_customer_phone: customerPhone,
    p_customer_name: customerName || null,
    p_customer_email: customerEmail || null,
    p_items: items,
    p_delivery_type: deliveryType || null,
    p_delivery_address: deliveryAddress || null,
  });
  if (error) {
    console.warn("bot_create_payment_link fallo:", error.message);
    return null;
  }
  return data as CreatePaymentLinkResult;
}

export async function createHandoff(
  phoneNumberId: string,
  customerPhone: string,
  customerName: string,
  reason: string,
  messageExcerpt: string
): Promise<void> {
  const { error } = await supabase.rpc("bot_create_handoff", {
    p_phone_number_id: phoneNumberId,
    p_customer_phone: customerPhone,
    p_customer_name: customerName || null,
    p_reason: reason || "no_entendido",
    p_message_excerpt: messageExcerpt,
  });
  if (error) {
    console.warn("bot_create_handoff fallo:", error.message);
  }
}

export async function getPaymentLinkForCharge(linkId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.rpc("bot_get_payment_link_for_charge", { p_link_id: linkId });
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

export async function setPaymentLinkSession(linkId: string, session: string, sessionKey: string): Promise<void> {
  await supabase.rpc("bot_set_payment_link_session", {
    p_link_id: linkId,
    p_session: session,
    p_session_key: sessionKey,
  });
}

// Pide a la Edge Function generate-order-invoice-pdf el mismo PDF de factura
// que descarga el boton "Descargar PDF" del POS (sin logo, ver el README de
// esa funcion), para adjuntarlo como documento en WhatsApp justo despues de
// crear el pedido.
export async function getOrderInvoicePdf(
  phoneNumberId: string,
  orderId: string,
): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const { data, error } = await supabase.functions.invoke<{ pdfBase64: string; filename: string }>(
    "generate-order-invoice-pdf",
    { body: { phone_number_id: phoneNumberId, order_id: orderId } },
  );
  if (error || !data?.pdfBase64) {
    console.warn("generate-order-invoice-pdf fallo:", error?.message);
    return null;
  }
  return { bytes: Buffer.from(data.pdfBase64, "base64"), filename: data.filename || `factura-${orderId}.pdf` };
}

// ============================================================
// Chat panel: conversaciones y mensajes
// ============================================================

export type ConvInfo = {
  id: string;
  restaurantId: string;
  botPaused: boolean;
};

export async function botUpsertConversation(
  phoneNumberId: string,
  customerPhone: string,
  customerName?: string,
): Promise<ConvInfo | null> {
  const { data, error } = await supabase.rpc("bot_upsert_conversation", {
    p_phone_number_id: phoneNumberId,
    p_customer_phone:  customerPhone,
    p_customer_name:   customerName ?? null,
  });
  if (error || !data) {
    console.warn("bot_upsert_conversation fallo:", error?.message);
    return null;
  }
  const row = data as { id: string; restaurant_id: string; bot_paused: boolean };
  return { id: row.id, restaurantId: row.restaurant_id, botPaused: row.bot_paused };
}

export async function botSaveMessage(
  conversationId: string,
  restaurantId: string,
  direction: "inbound" | "outbound",
  senderType: "customer" | "bot" | "human" | "system",
  content: string,
  waMessageId?: string,
): Promise<void> {
  const { error } = await supabase.rpc("bot_save_message", {
    p_conversation_id: conversationId,
    p_restaurant_id:   restaurantId,
    p_direction:       direction,
    p_sender_type:     senderType,
    p_content:         content,
    p_wa_message_id:   waMessageId ?? null,
  });
  if (error) console.warn("bot_save_message fallo:", error.message);
}

export async function botPauseConversation(
  conversationId: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc("bot_pause_conversation", {
    p_conversation_id: conversationId,
    p_reason:          reason ?? null,
  });
  if (error) console.warn("bot_pause_conversation fallo:", error.message);
}

export async function notifyNewOrder(payload: {
  to: string;
  restaurantName: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  items: { name: string; quantity: number }[];
  total: number;
  currencyCode: string;
  currencyLocale: string;
}): Promise<void> {
  // No es critico: si Resend no esta configurado en Supabase, esto falla pero
  // la orden ya quedo registrada igual (mismo comportamiento que en n8n).
  const { error } = await supabase.functions.invoke("notify-new-order", {
    body: payload,
  });
  if (error) {
    console.warn("notify-new-order fallo (la orden ya quedo registrada):", error.message);
  }
}
