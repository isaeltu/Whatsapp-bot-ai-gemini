# Bot de pedidos por WhatsApp para RestoPOS (whatsapp-web.js + Gemini)

Este bot reemplaza el flujo de n8n (`n8n/whatsapp-order-bot.json` en el repo de
RestoPOS) para tomar pedidos por WhatsApp. Usa el mismo backend de Supabase
(las funciones `bot_get_menu`, `bot_upsert_customer`, `bot_create_order` y
`bot_create_handoff`), pero:

- Se conecta a WhatsApp con `whatsapp-web.js` (escaneando un QR, como WhatsApp
  Web normal) en vez de la Cloud API de Meta. No hace falta una app de
  Business en developers.facebook.com ni verificar el negocio.
- Usa **Gemini** (Google Generative AI) en vez de Claude/Anthropic como LLM.
- Es un bot de **un solo restaurante**: el proceso mantiene una sola sesion de
  WhatsApp (un numero), a diferencia de n8n que podia atender varios
  restaurantes a la vez por `phone_number_id` de Meta.

## Como funciona

Por cada mensaje de texto o nota de voz entrante:

1. Lee el catalogo y la configuracion del restaurante con `bot_get_menu`
   (precios y productos siempre en vivo desde la base de datos).
2. Arma un system prompt con el negocio, el catalogo, el historial reciente de
   esa conversacion y la fecha/hora actual (zona Republica Dominicana).
3. Le pide a Gemini que devuelva un JSON `{ intent, replyText, items, reason,
   customerName, customerEmail }` (`intent` es `chat`, `order` o `handoff`).
4. Segun el intent:
   - `chat`: responde directo con `replyText` (preguntas, aclaraciones).
   - `order`: registra/actualiza el cliente (`bot_upsert_customer`), crea la
     orden (`bot_create_order`), notifica por correo si hay
     `notification_email` configurado, y confirma el pedido al cliente.
   - `handoff`: registra el caso en `whatsapp_handoffs` (visible en el panel
     admin) y avisa al cliente que alguien del negocio lo va a contactar.
5. Si Gemini no devuelve un JSON valido 3 veces seguidas para el mismo numero,
   se fuerza un handoff en vez de seguir insistiendo.

La memoria de conversacion (historial + intentos fallidos + nombre/correo ya
capturados) vive en un `Map` en RAM (`src/memory.ts`), igual de limitada que
el `workflowStaticData` que usaba n8n: se pierde si el proceso se reinicia.
Para esta escala (un restaurante, un proceso) es suficiente; si se necesita
sobrevivir reinicios habria que mover ese estado a una tabla de Supabase.

## 1. Configurar Supabase

Las migraciones ya existen en el repo de RestoPOS y no cambian (las mismas
funciones que usaba n8n):

```
supabase/migrations/202606230001_whatsapp_bot_and_order_cancel.sql
supabase/migrations/202606230002_whatsapp_bot_customer_capture.sql
```

Si todavia no se aplicaron: `supabase db push` en el repo de RestoPOS. La
Edge Function `notify-new-order` (correo de aviso de pedido nuevo) tampoco
cambia; se despliega igual que antes (`supabase functions deploy
notify-new-order` + secrets de Resend).

## 2. Configurar el `.env` de este bot

Copia `.env.example` a `.env` y completa:

- `GEMINI_API_KEY`: de [Google AI Studio](https://aistudio.google.com/apikey).
- `SUPABASE_URL` / `SUPABASE_ANON_KEY`: del mismo proyecto de Supabase que usa
  RestoPOS (Project Settings -> API). La anon key es publica, no es secreta.

## 3. Instalar y correr

```
npm install
npm run dev
```

Va a aparecer un QR en la terminal: escanealo con el WhatsApp del **numero
del negocio** (Ajustes -> Dispositivos vinculados -> Vincular un dispositivo).
La sesion se guarda en `.wwebjs_auth/` (gitignored) para no tener que volver a
escanear en cada reinicio.

Al conectar, la consola va a imprimir el numero del bot, por ejemplo:

```
WhatsApp listo. Numero del bot: 18091234567
```

## 4. Configurar el panel admin de RestoPOS

En la app: **Configuracion -> seccion "Bot de WhatsApp"**:

1. Activar "Activar bot de WhatsApp para este restaurante".
2. En el campo de Phone Number ID, pegar **el mismo numero que imprimio la
   consola al conectar** (sin "+", solo digitos). Ya no es el Phone Number ID
   de Meta -- ahora es el numero real de WhatsApp del bot.
3. Correo de notificacion de pedidos y las instrucciones adicionales
   (horarios, promociones, tono) funcionan exactamente igual que antes.
4. Guardar.

## 5. Probar end-to-end

1. Desde otro telefono, mandar un mensaje al numero del bot.
2. Verificar en la consola del bot que se loguea el mensaje y la respuesta.
3. Confirmar que la orden aparece en el POS con `channel = 'whatsapp'`, o si
   el bot no entendio, que aparecio un registro en "Bot de WhatsApp ->
   Handoffs" del panel admin.

## Limitaciones conocidas

- Un proceso = un restaurante = un numero de WhatsApp (ver arriba). Para
  varios restaurantes habria que correr un proceso por restaurante (cada uno
  con su propia carpeta `.wwebjs_auth`, su propio número, y resolverlo igual
  por ese número en `restaurant_bot_settings`).
- Se procesan mensajes de texto y notas de voz (Gemini transcribe e
  interpreta el audio en una sola llamada). Imagenes y stickers se ignoran
  (no rompen el flujo, pero tampoco generan respuesta).
- El audio de WhatsApp (notas de voz) consume mas tokens de entrada que el
  texto equivalente, asi que cuesta un poco mas por mensaje -- sigue siendo
  barato con `gemini-flash-lite-latest`, pero no es gratis como ignorarlo.
- whatsapp-web.js usa Puppeteer/Chromium por debajo: necesita un entorno con
  Chromium disponible (en Linux suele requerir las dependencias de
  `--no-sandbox` que ya estan configuradas) y un proceso de larga duracion
  (no sirve para serverless/funciones efimeras).
- La memoria de conversacion es solo en RAM (ver seccion "Como funciona").
