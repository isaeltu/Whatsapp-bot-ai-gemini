FROM node:22-bookworm-slim

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
