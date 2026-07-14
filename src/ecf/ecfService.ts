import ECF, { P12Reader, Transformer, ENVIRONMENT, Signature, convertECF32ToRFCE } from 'dgii-ecf';
import { getWhatsappIntegrationByPhoneNumber, supabase } from '../supabaseClient';
import { sendWhatsAppText } from '../metaWhatsapp';

async function resolveWhatsAppAccessToken(phoneNumberId: string): Promise<string | undefined> {
  const integration = await getWhatsappIntegrationByPhoneNumber(phoneNumberId).catch(() => null);
  return integration?.accessToken;
}

export interface EcfOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface EcfOrderData {
  restaurantId: string;
  orderId: string;
  orderNumber: number;
  businessDate: string;       // YYYY-MM-DD
  customerName?: string;
  customerRnc?: string;       // if provided → E31, else → E32
  customerPhone?: string;     // if present, send WhatsApp notification with e-NCF
  phoneNumberId?: string;     // WhatsApp Business phone_number_id of the restaurant
  subtotal: number;           // pre-tax amount
  taxTotal: number;           // ITBIS amount (18% of subtotal)
  total: number;              // final total (subtotal + taxTotal)
  paymentMethod: 'cash' | 'card' | 'transfer' | 'mixed';
  items: EcfOrderItem[];
}

export interface EcfResult {
  success: boolean;
  encf?: string;
  trackId?: string;
  error?: string;
}

export interface EcfCreditNoteData {
  restaurantId: string;
  orderId: string;
  orderNumber: number;
  businessDate: string;        // YYYY-MM-DD (hoy)
  originalEncf: string;        // e-NCF que se anula, ej. "E3200000000001"
  originalDate: string;        // YYYY-MM-DD (fecha del comprobante original)
  codigoModificacion?: number; // 1=Anulación (default), 2=Corrección, 3=Descuento
  subtotal: number;
  taxTotal: number;
  total: number;
  paymentMethod: 'cash' | 'card' | 'transfer' | 'mixed';
  items: EcfOrderItem[];
  customerPhone?: string;
  phoneNumberId?: string;
}

interface RestaurantEcfSettings {
  rnc_emisor: string;
  razon_social: string;
  nombre_comercial: string;
  direccion: string;
  municipio: string;
  provincia: string;
  telefono: string;
  correo: string;
  actividad_economica: string;
  p12_base64: string;
  p12_passphrase: string;
  encf_type31_next: number;
  encf_type32_next: number;
  encf_type34_next: number;
  encf_type31_expiry: string | null; // DD-MM-YYYY — REQUIRED for E31, assigned by DGII
  environment: 'test' | 'production';
  is_enabled: boolean;
}

// DGII requires DD-MM-YYYY for all date fields (NOT ISO 8601)
function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

// DGII requires DD-MM-YYYY HH:MM:SS for datetime fields
function formatDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dd = pad(date.getDate());
  const mm = pad(date.getMonth() + 1);
  const yyyy = date.getFullYear();
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${ss}`;
}

// DGII phone format: NNN-NNN-NNNN (with dashes)
function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // Return as-is if already formatted or unknown format
  return phone.includes('-') ? phone : digits;
}

// FormaPago codes per DGII spec (TablaFormasPago/FormaDePago)
// 1=Efectivo, 2=Cheque/Transfer/Depósito, 3=Tarjeta C/D, 4=Crédito,
// 5=Bonos, 6=Permuta, 7=Nota de Crédito, 8=Otras
function formaPagoCode(method: string): number {
  switch (method) {
    case 'cash':     return 1; // Efectivo
    case 'card':     return 3; // Tarjeta Crédito/Débito
    case 'transfer': return 2; // Cheque/Transferencia/Depósito
    case 'mixed':    return 8; // Otras (mixed is uncommon — use 8)
    default:         return 1;
  }
}

// El certificado ya no vive en columnas legibles: esta cifrado en reposo y
// solo se obtiene descifrado via RPC (service_role) con la clave de la
// plataforma. Exportado para que el poller lo reutilice.
export async function getEcfCertificate(
  restaurantId: string
): Promise<{ p12Base64: string; passphrase: string } | null> {
  const key = process.env.WHATSAPP_CREDENTIALS_KEY;
  if (!key) {
    console.error('[eCF] WHATSAPP_CREDENTIALS_KEY no configurada: no se puede leer el certificado');
    return null;
  }
  const { data, error } = await supabase.rpc('ecf_get_certificate', {
    p_restaurant_id: restaurantId,
    p_encryption_key: key,
  });
  if (error || !data) return null;
  const cert = data as { p12Base64?: string; passphrase?: string };
  if (!cert.p12Base64) return null;
  return { p12Base64: cert.p12Base64, passphrase: cert.passphrase ?? '' };
}

async function getEcfSettings(restaurantId: string): Promise<RestaurantEcfSettings | null> {
  const { data, error } = await supabase
    .from('restaurant_ecf_settings')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('is_enabled', true)
    .single();

  if (error || !data) return null;

  const cert = await getEcfCertificate(restaurantId);
  if (!cert) return null; // sin certificado no hay nada que firmar

  return {
    ...(data as Omit<RestaurantEcfSettings, 'p12_base64' | 'p12_passphrase'>),
    p12_base64: cert.p12Base64,
    p12_passphrase: cert.passphrase,
  } as RestaurantEcfSettings;
}

async function incrementEncfSequence(
  restaurantId: string,
  tipoEcf: 31 | 32 | 34,
  current: number
): Promise<void> {
  const col =
    tipoEcf === 31 ? 'encf_type31_next' :
    tipoEcf === 32 ? 'encf_type32_next' :
                     'encf_type34_next';
  await supabase
    .from('restaurant_ecf_settings')
    .update({ [col]: current + 1 })
    .eq('restaurant_id', restaurantId);
}

async function saveEcfRecord(
  restaurantId: string,
  orderId: string,
  encf: string,
  tipoEcf: number,
  trackId: string,
  xmlSigned: string
): Promise<void> {
  await supabase.from('order_ecf_records').insert({
    restaurant_id: restaurantId,
    order_id: orderId,
    encf,
    tipo_ecf: tipoEcf,
    track_id: trackId,
    xml_signed: xmlSigned,
    status: 'sent',
  });

  await supabase
    .from('orders')
    .update({ ecf_number: encf, ecf_status: 'sent' })
    .eq('id', orderId);
}

export async function generateAndSendEcf(data: EcfOrderData): Promise<EcfResult> {
  try {
    const settings = await getEcfSettings(data.restaurantId);
    if (!settings) {
      return { success: false, error: 'Restaurante no tiene e-CF habilitado' };
    }

    // E31 = Crédito Fiscal (requiere RNC comprador), E32 = Consumidor Final
    const tipoEcf: 31 | 32 = data.customerRnc ? 31 : 32;
    const seqNext = tipoEcf === 31 ? settings.encf_type31_next : settings.encf_type32_next;

    // e-NCF: E + tipo (2 dígitos) + secuencia (11 dígitos) = 13 chars total
    const encf = `E${tipoEcf}${String(seqNext).padStart(11, '0')}`;
    const fileName = `${settings.rnc_emisor.replace(/\D/g, '')}${encf}.xml`;

    const fechaEmision = formatDate(data.businessDate);
    const fechaHoraFirma = formatDateTime(new Date()); // set at signing time

    // MontoGravadoTotal = base imponible (sin ITBIS)
    // Si total incluye ITBIS: montoGravado = total / 1.18
    // Si los campos de la orden ya traen subtotal como base: montoGravado = subtotal
    const montoGravado = parseFloat((data.total - data.taxTotal).toFixed(2));

    // El XSD impone un orden fijo en IdDoc. Construimos respetando ese orden.
    const expiry = settings.encf_type31_expiry ?? '31-12-2099';
    const idDoc: Record<string, unknown> = {
      TipoeCF: { _text: tipoEcf },
      eNCF:    { _text: encf },
      // FechaVencimientoSecuencia: OBLIGATORIA en E31, no existe en E32
      ...(tipoEcf === 31 ? { FechaVencimientoSecuencia: { _text: expiry } } : {}),
      TipoIngresos: { _text: '01' },
      TipoPago:     { _text: 1 },
      TablaFormasPago: {
        FormaDePago: {
          FormaPago: { _text: formaPagoCode(data.paymentMethod) },
          MontoPago: { _text: data.total },
        },
      },
    };

    const ecfObject = {
      ECF: {
        Encabezado: {
          Version: { _text: '1.0' },
          IdDoc: idDoc,
          Emisor: {
            RNCEmisor:          { _text: settings.rnc_emisor.replace(/\D/g, '') },
            RazonSocialEmisor:  { _text: settings.razon_social.slice(0, 150) },
            NombreComercial:    { _text: (settings.nombre_comercial || settings.razon_social).slice(0, 150) },
            DireccionEmisor:    { _text: settings.direccion.slice(0, 100) },
            Municipio:          { _text: settings.municipio },
            Provincia:          { _text: settings.provincia },
            TablaTelefonoEmisor: {
              TelefonoEmisor: { _text: formatPhone(settings.telefono) },
            },
            ...(settings.correo ? { CorreoEmisor: { _text: settings.correo.slice(0, 80) } } : {}),
            ActividadEconomica:   { _text: settings.actividad_economica },
            NumeroFacturaInterna: { _text: String(data.orderNumber) },
            FechaEmision:         { _text: fechaEmision },
          },
          // Comprador: obligatorio en E31 Y E32 por XSD (hijos opcionales en E32)
          Comprador: data.customerRnc
            ? {
                RNCComprador:         { _text: data.customerRnc.replace(/\D/g, '') },
                RazonSocialComprador: { _text: (data.customerName || '').slice(0, 150) },
              }
            : {},
          Totales: {
            MontoGravadoTotal: { _text: montoGravado },
            MontoGravadoI1:    { _text: montoGravado }, // ITBIS tasa 1 (18%)
            MontoExento:       { _text: 0 },
            // ITBIS1 = la TASA como porcentaje entero (18, no 0.18)
            ITBIS1:     { _text: 18 },
            TotalITBIS:  { _text: parseFloat(data.taxTotal.toFixed(2)) },
            TotalITBIS1: { _text: parseFloat(data.taxTotal.toFixed(2)) },
            MontoTotal:  { _text: parseFloat(data.total.toFixed(2)) },
            ValorPagar:  { _text: parseFloat(data.total.toFixed(2)) },
          },
        },
        DetallesItems: {
          Item: data.items.map((item, i) => ({
            NumeroLinea: { _text: i + 1 },
            // IndicadorFacturacion: OBLIGATORIO
            // 1=ITBIS1(18%), 2=ITBIS2(16%), 3=ITBIS3(0%), 4=Exento, 0=No facturable
            IndicadorFacturacion:   { _text: 1 },
            NombreItem:             { _text: item.name.slice(0, 80) },
            // IndicadorBienoServicio: 1=Bien, 2=Servicio
            // Comida preparada en restaurante = 2 (Servicio)
            IndicadorBienoServicio: { _text: 2 },
            CantidadItem:           { _text: parseFloat(item.quantity.toFixed(2)) },
            UnidadMedida:           { _text: 1 }, // 1=Unidad
            PrecioUnitarioItem:     { _text: parseFloat(item.unitPrice.toFixed(4)) },
            MontoItem:              { _text: parseFloat(item.subtotal.toFixed(2)) },
          })),
        },
        // FechaHoraFirma: OBLIGATORIO, formato DD-MM-YYYY HH:MM:SS (NO ISO 8601)
        // Debe establecerse justo antes de firmar
        FechaHoraFirma: { _text: fechaHoraFirma },
      },
    };

    // Cargar certificado desde base64
    const p12Reader = new P12Reader(settings.p12_passphrase);
    const p12Data = p12Reader.getKeyFromStringBase64(settings.p12_base64);

    const env = settings.environment === 'production' ? ENVIRONMENT.PROD : ENVIRONMENT.DEV;
    const ecfClient = new ECF(p12Data, env);

    // Autenticar con DGII (seed → JWT)
    await ecfClient.authenticate();

    // Convertir a XML y firmar con XAdES-BES
    const transformer = new Transformer();
    const xmlUnsigned = transformer.json2xml(ecfObject, true);

    const signer = new Signature(p12Data.key!, p12Data.cert!);
    const xmlSigned = signer.signXml(xmlUnsigned, 'ECF');

    // E32 < 250,000 DOP → RFCE (resumen) al endpoint fc.dgii.gov.do
    // E31, E34, E32 >= 250k → documento completo al endpoint ecf.dgii.gov.do
    let trackId = '';
    if (tipoEcf === 32 && data.total < 250000) {
      const { xml: rfceUnsigned } = convertECF32ToRFCE(xmlSigned);
      const rfceXmlSigned = signer.signXml(rfceUnsigned, 'RFCE');
      const rfceResponse = await ecfClient.sendSummary(rfceXmlSigned, fileName);
      // RFCE response: { codigo, estado, mensajes, encf, secuenciaUtilizada }
      trackId = (rfceResponse as any)?.estado ?? String((rfceResponse as any)?.codigo ?? '');
    } else {
      const response = await ecfClient.sendElectronicDocument(xmlSigned, fileName);
      trackId = (response as any)?.trackId || (response as any)?.trackid || '';
    }

    // Persistir en base de datos
    await saveEcfRecord(data.restaurantId, data.orderId, encf, tipoEcf, trackId, xmlSigned);
    await incrementEncfSequence(data.restaurantId, tipoEcf, seqNext);

    // Notificar al cliente por WhatsApp (solo pedidos de canal WhatsApp)
    if (data.customerPhone && data.phoneNumberId) {
      const ecfMsg =
        `✅ *Comprobante Fiscal Electronico emitido*
` +
        `e-NCF: *${encf}*
` +
        `Puedes verificarlo en: ecf.dgii.gov.do`;
      resolveWhatsAppAccessToken(data.phoneNumberId)
        .then((token) => sendWhatsAppText(data.phoneNumberId!, data.customerPhone!, ecfMsg, token))
        .catch((err: unknown) => {
        console.warn('[ECF] No se pudo enviar e-NCF por WhatsApp:', err);
      });
    }

    return { success: true, encf, trackId };
  } catch (err: any) {
    console.error('[ECF] Error generando e-CF:', err);
    return { success: false, error: err?.message || 'Error desconocido' };
  }
}

// E34 — Nota de Crédito Electrónica.
// Se emite para anular o corregir un comprobante ya emitido (E31 o E32).
// Requiere InformacionReferencia con el eNCF original; la DGII lo cruza.
export async function generateCreditNote(data: EcfCreditNoteData): Promise<EcfResult> {
  try {
    const settings = await getEcfSettings(data.restaurantId);
    if (!settings) {
      return { success: false, error: 'Restaurante no tiene e-CF habilitado' };
    }

    const tipoEcf = 34;
    const seqNext = settings.encf_type34_next;
    const encf = `E${tipoEcf}${String(seqNext).padStart(11, '0')}`;
    const fileName = `${settings.rnc_emisor.replace(/\D/g, '')}${encf}.xml`;

    const fechaEmision = formatDate(data.businessDate);
    const fechaNCFModificado = formatDate(data.originalDate);
    const fechaHoraFirma = formatDateTime(new Date());
    const montoGravado = parseFloat((data.total - data.taxTotal).toFixed(2));
    const codigo = data.codigoModificacion ?? 1; // 1=Anulación

    // 0 = ≤30 días desde el comprobante original; 1 = >30 días
    const emisionMs  = new Date(data.businessDate).getTime();
    const originalMs = new Date(data.originalDate).getTime();
    const diasDiferencia = Math.floor((emisionMs - originalMs) / (1000 * 60 * 60 * 24));
    const indicadorNotaCredito = diasDiferencia > 30 ? 1 : 0;

    const ecfObject = {
      ECF: {
        Encabezado: {
          Version: { _text: '1.0' },
          IdDoc: {
            TipoeCF:              { _text: tipoEcf },
            eNCF:                 { _text: encf },
            IndicadorNotaCredito: { _text: indicadorNotaCredito },
            TipoIngresos:         { _text: '01' },
            TipoPago:             { _text: 1 },
            TablaFormasPago: {
              FormaDePago: {
                FormaPago: { _text: formaPagoCode(data.paymentMethod) },
                MontoPago:  { _text: data.total },
              },
            },
          },
          Emisor: {
            RNCEmisor:          { _text: settings.rnc_emisor.replace(/\D/g, '') },
            RazonSocialEmisor:  { _text: settings.razon_social.slice(0, 150) },
            NombreComercial:    { _text: (settings.nombre_comercial || settings.razon_social).slice(0, 150) },
            DireccionEmisor:    { _text: settings.direccion.slice(0, 100) },
            Municipio:          { _text: settings.municipio },
            Provincia:          { _text: settings.provincia },
            TablaTelefonoEmisor: {
              TelefonoEmisor: { _text: formatPhone(settings.telefono) },
            },
            ...(settings.correo ? { CorreoEmisor: { _text: settings.correo.slice(0, 80) } } : {}),
            ActividadEconomica:   { _text: settings.actividad_economica },
            NumeroFacturaInterna: { _text: String(data.orderNumber) },
            FechaEmision:         { _text: fechaEmision },
          },
          Totales: {
            MontoGravadoTotal: { _text: montoGravado },
            MontoGravadoI1:    { _text: montoGravado },
            MontoExento:       { _text: 0 },
            ITBIS1:            { _text: 18 },
            TotalITBIS:        { _text: parseFloat(data.taxTotal.toFixed(2)) },
            TotalITBIS1:       { _text: parseFloat(data.taxTotal.toFixed(2)) },
            MontoTotal:        { _text: parseFloat(data.total.toFixed(2)) },
            ValorPagar:        { _text: parseFloat(data.total.toFixed(2)) },
          },
        },
        DetallesItems: {
          Item: data.items.map((item, i) => ({
            NumeroLinea:            { _text: i + 1 },
            IndicadorFacturacion:   { _text: 1 },
            NombreItem:             { _text: item.name.slice(0, 80) },
            IndicadorBienoServicio: { _text: 2 },
            CantidadItem:           { _text: parseFloat(item.quantity.toFixed(2)) },
            UnidadMedida:           { _text: 1 },
            PrecioUnitarioItem:     { _text: parseFloat(item.unitPrice.toFixed(4)) },
            MontoItem:              { _text: parseFloat(item.subtotal.toFixed(2)) },
          })),
        },
        // InformacionReferencia: OBLIGATORIO en E34 — cruza el comprobante original
        InformacionReferencia: {
          NCFModificado:      { _text: data.originalEncf },
          FechaNCFModificado: { _text: fechaNCFModificado },
          // 1=Anulación total, 2=Corrección de montos, 3=Descuento/bonificación
          CodigoModificacion: { _text: codigo },
        },
        FechaHoraFirma: { _text: fechaHoraFirma },
      },
    };

    const p12Reader = new P12Reader(settings.p12_passphrase);
    const p12Data = p12Reader.getKeyFromStringBase64(settings.p12_base64);
    const env = settings.environment === 'production' ? ENVIRONMENT.PROD : ENVIRONMENT.DEV;
    const ecfClient = new ECF(p12Data, env);
    await ecfClient.authenticate();

    const transformer = new Transformer();
    const xmlUnsigned = transformer.json2xml(ecfObject, true);
    const signer = new Signature(p12Data.key!, p12Data.cert!);
    const xmlSigned = signer.signXml(xmlUnsigned, 'ECF');

    const response = await ecfClient.sendElectronicDocument(xmlSigned, fileName);
    const trackId = (response as any)?.trackId || (response as any)?.trackid || '';

    await saveEcfRecord(data.restaurantId, data.orderId, encf, tipoEcf, trackId, xmlSigned);
    await incrementEncfSequence(data.restaurantId, tipoEcf, seqNext);

    if (data.customerPhone && data.phoneNumberId) {
      const msg =
        `📋 *Nota de Credito emitida*
` +
        `e-NCF: *${encf}*
` +
        `Anula: ${data.originalEncf}
` +
        `Puedes verificarlo en: ecf.dgii.gov.do`;
      resolveWhatsAppAccessToken(data.phoneNumberId)
        .then((token) => sendWhatsAppText(data.phoneNumberId!, data.customerPhone!, msg, token))
        .catch((err: unknown) => {
        console.warn('[ECF] No se pudo enviar nota de credito por WhatsApp:', err);
      });
    }

    return { success: true, encf, trackId };
  } catch (err: any) {
    console.error('[ECF] Error generando Nota de Credito E34:', err);
    return { success: false, error: err?.message || 'Error desconocido' };
  }
}
