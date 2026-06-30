# Bot de pedidos por WhatsApp para RestoPOS (Meta Cloud API + Gemini)

Este bot recibe mensajes de WhatsApp via la **API oficial de Meta (WhatsApp
Cloud API)**, usa **Gemini** (Google Generative AI) para interpretar el
pedido contra el catalogo real de Supabase, y responde por WhatsApp. Usa el
mismo backend de Supabase de siempre (las funciones `bot_get_menu`,
`bot_upsert_customer`, `bot_create_order` y `bot_create_handoff`).

> Version anterior: este bot corria sobre `whatsapp-web.js` (sesion de
> WhatsApp Web escaneada por QR, no oficial). Se migro a la Cloud API de Meta
> porque whatsapp-web.js viola los terminos de servicio de WhatsApp y Meta
> puede banear el numero sin aviso -- no es aceptable para un numero que un
> restaurante paga por usar. La logica de negocio (Gemini, prompt, Supabase,
> memoria, rate limit) no cambio nada; solo el transporte.

## Como funciona

Por cada mensaje de texto o nota de voz entrante al webhook:

1. Lee el catalogo y la configuracion del restaurante con `bot_get_menu`,
   resolviendo el restaurante por `phone_number_id` (el numero de WhatsApp
   del negocio que Meta manda en cada webhook).
2. Arma un system prompt con el negocio, el catalogo, el historial reciente
   de esa conversacion y la fecha/hora actual (zona Republica Dominicana).
3. Le pide a Gemini que devuelva un JSON `{ intent, replyText, items, reason,
   customerName, customerEmail, deliveryType, deliveryAddress }`.
4. Segun el intent:
   - `chat`: responde directo con `replyText`.
   - `order`: registra/actualiza el cliente, crea la orden, notifica por
     correo si hay `notification_email` configurado, y confirma el pedido.
   - `handoff`: registra el caso en `whatsapp_handoffs` (visible en el panel
     admin) y avisa al cliente que alguien del negocio lo va a contactar.
5. Si Gemini no devuelve un JSON valido 3 veces seguidas para el mismo
   numero, se fuerza un handoff en vez de seguir insistiendo.

La memoria de conversacion vive en Redis (Upstash, sobrevive reinicios). El
rate limiter limita mensajes por minuto por numero de telefono.

**Multi-restaurante en un solo proceso**: a diferencia de la version con
whatsapp-web.js (un proceso = un numero), este bot puede atender varios
restaurantes a la vez en un solo proceso/servidor, porque cada webhook de
Meta trae el `phone_number_id` del numero al que escribieron. Para sumar un
restaurante nuevo solo hace falta agregar su numero a la Cloud API y
configurar su `restaurant_bot_settings` en Supabase -- no hay que levantar un
proceso ni una sesion nueva.

## 1. Configurar Supabase

Las migraciones ya existen en el repo de RestoPOS y no cambian:

```
supabase/migrations/202606230001_whatsapp_bot_and_order_cancel.sql
supabase/migrations/202606230002_whatsapp_bot_customer_capture.sql
```

Si todavia no se aplicaron: `supabase db push` en el repo de RestoPOS. La
Edge Function `notify-new-order` tampoco cambia.

## 2. Crear la app de Meta y el numero de WhatsApp

1. Entra a [developers.facebook.com](https://developers.facebook.com) con tu
   cuenta de Facebook personal (no hace falta tener una empresa registrada
   para empezar a probar).
2. **Mis apps -> Crear app -> tipo "Negocio"**. Agrega el producto
   **WhatsApp**.
3. En **WhatsApp -> Configuracion de la API (API Setup)** vas a ver:
   - Un **numero de prueba** que Meta te da gratis (sirve para probar sin
     verificar negocio, pero solo le puede escribir a numeros que agregues
     como "destinatarios de prueba" en esa misma pantalla).
   - Un **Phone number ID** (ese es el valor que despues va en el panel
     admin de RestoPOS, en "Bot de WhatsApp" -> "Phone Number ID").
   - Un **Access token temporal** (dura 24h, sirve para probar ya mismo).
4. Para produccion (token que no expire): **Configuracion del negocio ->
   Usuarios del sistema -> Agregar -> crear un System User**, asignarle el
   activo de WhatsApp con permiso `whatsapp_business_messaging`, y generar un
   token sin fecha de expiracion. Ese va en `META_WHATSAPP_ACCESS_TOKEN`.

## 3. Configurar el `.env` de este bot

Copia `.env.example` a `.env` y completa:

- `GEMINI_API_KEY`: de [Google AI Studio](https://aistudio.google.com/apikey).
- `SUPABASE_URL` / `SUPABASE_ANON_KEY`: del mismo proyecto de Supabase que
  usa RestoPOS.
- `META_WHATSAPP_ACCESS_TOKEN`: el token del paso 2 (temporal para probar,
  permanente para produccion).
- `META_VERIFY_TOKEN`: invéntate un string largo al azar (ej. genera uno con
  `openssl rand -hex 32`). Lo vas a pegar tal cual en el paso 5.
- `META_APP_SECRET`: developers.facebook.com -> tu app -> Configuracion
  basica -> "Clave secreta de la app" (App secret). Valida que los webhooks
  realmente vienen de Meta.
- `BOT_ADMIN_TOKEN`: cualquier string largo al azar, protege `/health` y
  `/control`.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`: de
  [upstash.com](https://upstash.com) (Redis -> Create Database -> REST API).

## 4. Correr en local con un tunel publico (para probar)

Meta necesita una URL **publica** y con HTTPS para mandar los webhooks; no
le puede pegar a `localhost`. Para probar antes de subir a un VPS, usa un
tunel (ej. `ngrok http 5000` o `cloudflared tunnel --url http://localhost:5000`)
y copia la URL `https://...` que te de.

```
npm install
npm run dev
```

## 5. Configurar el webhook en Meta

En **WhatsApp -> Configuracion -> Webhooks** (o en API Setup, seccion
Webhook):

1. **Callback URL**: `https://<tu-tunel-o-dominio>/webhook`.
2. **Verify token**: el mismo valor exacto que pusiste en `META_VERIFY_TOKEN`.
3. Clic en **Verificar y guardar** -- Meta hace un GET a tu `/webhook`; si
   los logs del bot muestran "Verificacion de webhook de Meta OK." quedo
   bien.
4. **Suscribirse al campo `messages`** para ese numero/WABA (si no, nunca te
   van a llegar mensajes entrantes, solo la verificacion).

## 6. Configurar el panel admin de RestoPOS

En la app: **Configuracion -> seccion "Bot de WhatsApp"**:

1. Activar "Activar bot de WhatsApp para este restaurante".
2. **Phone Number ID**: pegar el mismo Phone Number ID del paso 2.3 (Meta).
3. Correo de notificacion de pedidos e instrucciones adicionales (horarios,
   promociones, tono) igual que antes.
4. Guardar.

## 7. Probar end-to-end

1. Mientras la app de Meta este en modo desarrollo, solo numeros agregados
   como "destinatarios de prueba" (paso 2.3) pueden escribirle al bot.
2. Manda un mensaje de WhatsApp al numero de prueba desde ese telefono.
3. Verifica en los logs del bot que se loguea `[diagnostico] Mensaje
   entrante...` y la respuesta.
4. Confirma que la orden aparece en el POS con `channel = 'whatsapp'`, o si
   el bot no entendio, que aparecio un registro en "Bot de WhatsApp ->
   Handoffs" del panel admin.

## 8. Desplegar en un VPS (recomendado para produccion)

A diferencia de la version con whatsapp-web.js, este bot **no necesita
Chromium ni disco persistente** -- es un servidor Express comun. Cualquier
VPS chico (ej. Hetzner CPX21/CPX31) alcanza para varios restaurantes en el
mismo proceso.

1. Subir este repo a tu VPS (git clone o `docker build` con el `Dockerfile`
   incluido).
2. Configurar las variables de entorno del paso 3 en el servidor.
3. Correr detras de un reverse proxy con HTTPS (ej. Caddy o Nginx +
   Let's Encrypt) -- Meta exige HTTPS real para el webhook, no autofirmado.
4. Apuntar el **Callback URL** de Meta (paso 5) al dominio real, ya no al
   tunel de pruebas.
5. Si vas a sumar mas restaurantes despues, cada uno solo necesita su propio
   numero de WhatsApp (mismo WABA o WABA nuevo) apuntando al mismo
   `/webhook` -- el `phone_number_id` de cada mensaje entrante ya distingue
   de que restaurante es.

## Limitaciones conocidas

- Se procesan mensajes de texto y notas de voz (Gemini transcribe e
  interpreta el audio en una sola llamada). Imagenes, stickers y ubicacion
  se ignoran (no rompen el flujo, pero tampoco generan respuesta).
- Mientras la app de Meta no pase por **Verificacion de Negocio**, el limite
  es 250 conversaciones nuevas por dia y solo le puede escribir a numeros
  agregados como "destinatarios de prueba". Para produccion real con
  clientes de un restaurante hay que verificar el negocio en Meta Business
  Settings.
- Mensajes proactivos (recordatorio de reserva, "tu pedido va en camino"
  fuera de la ventana de 24h desde el ultimo mensaje del cliente) requieren
  **templates pre-aprobados por Meta** -- este bot v1 solo responde dentro de
  esa ventana, no manda mensajes proactivos todavia.
