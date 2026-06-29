import { createClient } from "@supabase/supabase-js";
import {
  CreateOrderResult,
  MenuSnapshot,
  OrderItem,
  UpsertCustomerResult,
} from "./types";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Faltan SUPABASE_URL / SUPABASE_ANON_KEY en el .env");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
