FROM node:22-bookworm-slim

# Librerias de sistema que necesita Chromium headless para correr. El
# Chromium en si lo descarga Puppeteer mas abajo (npm ci) -- el de apt en
# Debian bookworm es una version muy nueva (149) que dio problemas raros con
# whatsapp-web.js ("Execution context was destroyed" al inyectar el script).
# Mejor usar el mismo Chromium que Puppeteer ya descarga y que se probo
# funcionando en local.
RUN apt-get update && apt-get install -y --no-install-recommends \
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
