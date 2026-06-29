FROM node:20-bookworm-slim

# Librerias de sistema que necesita Chromium headless para correr (whatsapp-web.js
# las necesita aunque el Chromium en si lo instale npm/puppeteer). Sin esto,
# Railway/Docker arranca pero el bot crashea al intentar lanzar el navegador.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libasound2 \
    libxss1 \
    libxshmfence1 \
    libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

# Usa el Chromium instalado por apt (mas rapido de construir, mismas libs de
# sistema que ya instalamos arriba) en vez de que Puppeteer descargue el suyo.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
# --include=dev explicito: NODE_ENV=production (puesto mas abajo, para el
# proceso en runtime) hace que npm se salte devDependencies por defecto, pero
# typescript/@types/* son devDependencies y se necesitan para compilar.
RUN npm ci --include=dev

COPY . .
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
