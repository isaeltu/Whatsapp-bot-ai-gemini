import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  throw new Error(
    "Faltan UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN en el .env. " +
      "Crea una base gratis en https://upstash.com (Redis -> Create Database -> REST API) y copia esos 2 valores."
  );
}

export const redis = new Redis({ url, token });
