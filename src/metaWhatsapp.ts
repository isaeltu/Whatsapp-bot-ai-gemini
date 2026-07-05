const apiVersion = process.env.META_API_VERSION || "v21.0";
const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;

function resolveAccessToken(override?: string): string {
  const token = override || accessToken;
  if (!token) {
    throw new Error("Falta META_WHATSAPP_ACCESS_TOKEN o accessToken de la integracion WhatsApp.");
  }
  return token;
}

// phoneNumberId identifica el numero de WhatsApp del NEGOCIO (no del bot como
// proceso): llega en cada webhook entrante (value.metadata.phone_number_id),
// asi que un mismo proceso puede atender varios restaurantes/numeros a la vez
// si todos apuntan al mismo webhook.
export async function sendWhatsAppText(phoneNumberId: string, to: string, body: string, tokenOverride?: string): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveAccessToken(tokenOverride)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Meta API respondio ${res.status} al enviar mensaje: ${errText}`);
  }
}

// Sube un archivo (ej. el PDF de la factura) a los servidores de Meta y
// devuelve un media id; ese id es lo que se manda despues en el mensaje tipo
// "document" (sendWhatsAppDocument). El archivo en si no viaja en el mensaje.
export async function uploadMedia(
  phoneNumberId: string,
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  tokenOverride?: string,
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([bytes as BlobPart], { type: mimeType }), filename);

  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${resolveAccessToken(tokenOverride)}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Meta API respondio ${res.status} al subir el archivo: ${errText}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error("Meta no devolvio un media id al subir el archivo.");
  }
  return data.id;
}

export async function sendWhatsAppDocument(
  phoneNumberId: string,
  to: string,
  mediaId: string,
  filename: string,
  caption?: string,
  tokenOverride?: string,
): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveAccessToken(tokenOverride)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId, filename, caption },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Meta API respondio ${res.status} al enviar el documento: ${errText}`);
  }
}

// Las notas de voz llegan en el webhook solo como un media id; hay que
// resolver la URL real (paso 1, expira rapido) y descargar el binario aparte
// (paso 2), ambos pasos exigen el mismo access token.
export async function downloadMedia(mediaId: string, tokenOverride?: string): Promise<{ mimeType: string; base64: string } | null> {
  const token = resolveAccessToken(tokenOverride);
  const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    console.warn(`No se pudo resolver la URL del media ${mediaId}: ${metaRes.status}`);
    return null;
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) return null;

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) {
    console.warn(`No se pudo descargar el media ${mediaId}: ${fileRes.status}`);
    return null;
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { mimeType: meta.mime_type || "audio/ogg", base64: buffer.toString("base64") };
}
