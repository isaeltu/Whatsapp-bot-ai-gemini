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
# En contenedor el proxy vive fuera, asi que hay que escuchar en todas las
# interfaces (fuera de Docker el default del codigo es 127.0.0.1).
ENV BIND_HOST=0.0.0.0
CMD ["node", "dist/index.js"]
