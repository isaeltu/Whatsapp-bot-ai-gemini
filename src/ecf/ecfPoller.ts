import ECF, { P12Reader, ENVIRONMENT } from 'dgii-ecf';
import { supabase } from '../supabaseClient';

interface PendingRecord {
  id: string;
  restaurant_id: string;
  encf: string;
  track_id: string;
}

interface EcfSettingsRow {
  p12_base64: string;
  p12_passphrase: string;
  environment: 'test' | 'production';
}

async function checkAndUpdateStatuses(): Promise<void> {
  // Buscar todos los registros en estado 'sent' que tengan track_id
  const { data: pending, error } = await supabase
    .from('order_ecf_records')
    .select('id, restaurant_id, encf, track_id')
    .eq('status', 'sent')
    .not('track_id', 'is', null)
    .limit(50);

  if (error || !pending || pending.length === 0) return;

  // Agrupar por restaurante para reutilizar el cliente ECF
  const byRestaurant = new Map<string, PendingRecord[]>();
  for (const row of pending as PendingRecord[]) {
    const list = byRestaurant.get(row.restaurant_id) ?? [];
    list.push(row);
    byRestaurant.set(row.restaurant_id, list);
  }

  for (const [restaurantId, records] of byRestaurant) {
    try {
      const { data: settings } = await supabase
        .from('restaurant_ecf_settings')
        .select('p12_base64, p12_passphrase, environment')
        .eq('restaurant_id', restaurantId)
        .eq('is_enabled', true)
        .single();

      if (!settings) continue;

      const cfg = settings as EcfSettingsRow;
      const p12Reader = new P12Reader(cfg.p12_passphrase);
      const p12Data = p12Reader.getKeyFromStringBase64(cfg.p12_base64);
      const env = cfg.environment === 'production' ? ENVIRONMENT.PROD : ENVIRONMENT.DEV;
      const ecfClient = new ECF(p12Data, env);
      await ecfClient.authenticate();

      for (const record of records) {
        try {
          const statusResponse = await ecfClient.statusTrackId(record.track_id) as { estado?: string; Estado?: string } | null;
          const estado = statusResponse?.estado ?? statusResponse?.Estado ?? '';

          // DGII devuelve: "Aceptado", "Rechazado", "En proceso"
          let newStatus: 'accepted' | 'rejected' | 'sent' = 'sent';
          if (/aceptado/i.test(estado)) newStatus = 'accepted';
          else if (/rechazado/i.test(estado)) newStatus = 'rejected';

          if (newStatus !== 'sent') {
            await supabase
              .from('order_ecf_records')
              .update({ status: newStatus, dgii_response: statusResponse })
              .eq('id', record.id);

            await supabase
              .from('orders')
              .update({ ecf_status: newStatus })
              .eq('ecf_number', record.encf)
              .eq('restaurant_id', restaurantId);

            console.log(`[ECF Poller] ${record.encf} → ${newStatus}`);
          }
        } catch (recordErr) {
          console.error(`[ECF Poller] Error consultando ${record.encf}:`, recordErr);
        }
      }
    } catch (restaurantErr) {
      console.error(`[ECF Poller] Error procesando restaurante ${restaurantId}:`, restaurantErr);
    }
  }
}

export function startEcfStatusPoller(intervalMs = 5 * 60 * 1000): void {
  console.log('[ECF Poller] Iniciado — revisando estados cada', intervalMs / 60000, 'minutos');
  // Primera revision a los 30s de arrancar (no bloquear el inicio)
  setTimeout(() => void checkAndUpdateStatuses(), 30_000);
  setInterval(() => void checkAndUpdateStatuses(), intervalMs);
}
