import { redis } from "./redisClient";

const WINDOW_SECONDS = 60;
const MAX_MESSAGES_PER_WINDOW = Number(process.env.RATE_LIMIT_MESSAGES_PER_MINUTE) || 12;

// Tope simple por numero de telefono: evita que alguien (o un bug en algun
// cliente de WhatsApp) bombardee el bot con mensajes en rafaga, lo cual
// gastaria cuota real de la API de Gemini sin ningun beneficio. Patron
// estandar INCR + EXPIRE: el primer mensaje de la ventana arma el contador
// con su propio TTL de 60s; cuando expira, la ventana siguiente arranca de 0.
export async function isRateLimited(phone: string): Promise<boolean> {
  const key = `wa-bot:ratelimit:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }
  return count > MAX_MESSAGES_PER_WINDOW;
}
