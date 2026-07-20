import { redis } from "./redisClient";
import { ConversationState, CustomerLookupResult } from "./types";

// Memoria de conversacion por numero del restaurante + numero del cliente.
// El mismo WhatsApp puede hablar con restaurantes distintos sin mezclar estado.
const MAX_TURNS = 12;
const HANDOFF_AFTER_FAILED_ATTEMPTS = 3;
const STATE_TTL_SECONDS = 60 * 60 * 6;

function keyFor(phoneNumberId: string, phone: string): string {
  return `wa-bot:conversation:${phoneNumberId}:${phone}`;
}

function emptyState(customerPhone = ""): ConversationState {
  return {
    stage: "CHECK_CUSTOMER",
    history: [],
    failedAttempts: 0,
    profile: { customerId: "", phone: customerPhone, name: "", email: "" },
    deliveryType: "",
    deliveryAddress: "",
  };
}

function normalizeState(state: ConversationState | null, customerPhone: string): ConversationState {
  const base = state ?? emptyState(customerPhone);
  return {
    ...base,
    stage: base.stage || "CHECK_CUSTOMER",
    profile: {
      customerId: base.profile?.customerId || "",
      phone: base.profile?.phone || customerPhone,
      name: base.profile?.name || "",
      email: base.profile?.email || "",
    },
  };
}

export async function getState(phoneNumberId: string, phone: string): Promise<ConversationState> {
  const stored = await redis.get<ConversationState>(keyFor(phoneNumberId, phone));
  return normalizeState(stored ?? null, phone);
}

export async function saveState(phoneNumberId: string, phone: string, state: ConversationState): Promise<void> {
  await redis.set(keyFor(phoneNumberId, phone), state, { ex: STATE_TTL_SECONDS });
}

export function recordCustomerMessage(state: ConversationState, text: string): void {
  state.history.push({ role: "customer", text, at: new Date().toISOString() });
  state.history = state.history.slice(-MAX_TURNS);
}

export function recordBotMessage(state: ConversationState, text: string): void {
  state.history.push({ role: "bot", text, at: new Date().toISOString() });
  state.history = state.history.slice(-MAX_TURNS);
}

export function recordFailedAttempt(state: ConversationState): boolean {
  state.failedAttempts += 1;
  return state.failedAttempts >= HANDOFF_AFTER_FAILED_ATTEMPTS;
}

export function resetFailedAttempts(state: ConversationState): void {
  state.failedAttempts = 0;
}

export function setCustomerProfile(state: ConversationState, customer: CustomerLookupResult): void {
  state.profile = {
    customerId: customer.customerId,
    phone: customer.phone || state.profile.phone,
    name: customer.fullName || state.profile.name,
    email: customer.email || state.profile.email,
  };
  // Solo se exige el nombre; el correo ya no se pide.
  state.stage = customer.missingName ? "ASK_CUSTOMER_NAME" : "CUSTOMER_IDENTIFIED";
}

export function updateProfile(state: ConversationState, name: string, email: string): void {
  state.profile = {
    ...state.profile,
    name: name.trim() || state.profile.name,
    email: email.trim() || state.profile.email,
  };
}

export function updateDelivery(state: ConversationState, deliveryType: string, deliveryAddress: string): void {
  const normalizedType = deliveryType.trim().toLowerCase();
  if (normalizedType === "pickup" || normalizedType === "delivery") {
    state.deliveryType = normalizedType;
  }
  state.deliveryAddress = deliveryAddress.trim() || state.deliveryAddress;
}
