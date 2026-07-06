import { supabaseService } from "./supabaseClient";

// Logging operativo hacia platform_logs (Supabase), la tabla que lee el panel
// de Super Admin de Restpo. Estandar de cada entrada: nivel + origen + codigo
// de evento estable (ej. "whatsapp.send_failed") + mensaje humano + metadata
// JSON. Fire-and-forget: un fallo del logging jamas debe tumbar el flujo del
// bot, por eso todo error se traga con un console.warn.

export type LogLevel = "debug" | "info" | "warn" | "error";

export function logPlatformEvent(
  level: LogLevel,
  event: string,
  message: string,
  restaurantId?: string | null,
  metadata?: Record<string, unknown>,
): void {
  const line = `[${event}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  if (!supabaseService) return;
  supabaseService
    .rpc("log_platform_event", {
      p_level: level,
      p_source: "bot",
      p_event: event,
      p_message: message,
      p_restaurant_id: restaurantId ?? null,
      p_metadata: metadata ?? {},
    })
    .then(({ error }) => {
      if (error) console.warn("No se pudo escribir platform_log:", error.message);
    });
}

// Enmascara telefonos en logs/metadata: solo se conservan los ultimos 4
// digitos, suficiente para correlacionar sin guardar el numero completo.
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 4 ? `***${digits.slice(-4)}` : "***";
}
