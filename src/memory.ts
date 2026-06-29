import { redis } from "./redisClient";
import { ConversationState } from "./types";

// Memoria de conversacion por numero de telefono. Antes vivia en un Map en
// RAM del proceso (se perdia en cada reinicio); ahora vive en Redis
// (Upstash), asi que sobrevive reinicios/redeploys del bot.
//
// Para minimizar llamadas a Redis, el patron es: 1 GET al inicio de cada
// mensaje (getState), mutaciones puras y sincronas en memoria sobre ese
// objeto (las funciones de abajo), y 1 SET al final (saveState). Nunca se
// hace una llamada a Redis por cada mutacion individual.

const MAX_TURNS = 12;
const HANDOFF_AFTER_FAILED_ATTEMPTS = 3;
// Si una conversacion queda inactiva por mas de esto, se "olvida" sola
// (libera espacio en Redis); un cliente que vuelve despues de eso simplemente
// empieza una conversacion nueva, igual que si el proceso se hubiera reiniciado.
const STATE_TTL_SECONDS = 60 * 60 * 6;

function keyFor(phone: string): string {
  return `wa-bot:conversation:${phone}`;
}

function emptyState(): ConversationState {
  return {
    history: [],
    failedAttempts: 0,
    profile: { name: "", email: "" },
    deliveryType: "",
    deliveryAddress: "",
  };
}

export async function getState(phone: string): Promise<ConversationState> {
  const stored = await redis.get<ConversationState>(keyFor(phone));
  return stored ?? emptyState();
}

export async function saveState(phone: string, state: ConversationState): Promise<void> {
  await redis.set(keyFor(phone), state, { ex: STATE_TTL_SECONDS });
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

export function updateProfile(state: ConversationState, name: string, email: string): void {
  state.profile = {
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
