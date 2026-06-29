import { GoogleGenerativeAI } from "@google/generative-ai";
import { IncomingMessage, LlmResult } from "./types";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("Falta GEMINI_API_KEY en el .env");
}

const genAI = new GoogleGenerativeAI(apiKey);
const modelName = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

function extractJson(raw: string): Record<string, unknown> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Le pedimos al modelo el mismo contrato JSON que usaba el AI Agent de n8n
// (ver n8n/whatsapp-order-bot.json, nodo "Parsear salida del LLM"), pero la
// llamada es sin estado: el systemPrompt ya trae el historial embebido, asi
// que no usamos un ChatSession persistente (cambiaria de catalogo/hora en
// cada turno y no tendria sentido reusar sesion). Si el mensaje es una nota
// de voz, se manda el audio directo (Gemini lo transcribe e interpreta en
// una sola llamada, en vez de transcribir y luego interpretar por separado).
export async function interpretMessage(
  systemPrompt: string,
  message: IncomingMessage
): Promise<LlmResult | null> {
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: 800,
      temperature: 0.2,
      responseMimeType: "application/json",
      // Sin esto, los modelos gemini-2.5/3.x "piensan" antes de responder y
      // ese razonamiento interno consume el maxOutputTokens, dejando la
      // respuesta cortada (finishReason MAX_TOKENS con el JSON incompleto).
      thinkingConfig: { thinkingBudget: 0 },
    } as Record<string, unknown>,
  });

  const contentPart =
    message.kind === "text"
      ? message.text
      : [{ inlineData: { mimeType: message.mimeType, data: message.data } }];

  const result = await model.generateContent(contentPart);
  const text = result.response.text();
  const parsed = extractJson(text);

  if (!parsed || typeof parsed.intent !== "string") {
    return null;
  }

  return {
    intent: (parsed.intent as LlmResult["intent"]) ?? "chat",
    replyText: typeof parsed.replyText === "string" ? parsed.replyText : "",
    items: Array.isArray(parsed.items) ? (parsed.items as LlmResult["items"]) : [],
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    customerName: typeof parsed.customerName === "string" ? parsed.customerName : "",
    customerEmail: typeof parsed.customerEmail === "string" ? parsed.customerEmail : "",
    transcript: typeof parsed.transcript === "string" ? parsed.transcript : "",
    deliveryType: typeof parsed.deliveryType === "string" ? parsed.deliveryType : "",
    deliveryAddress: typeof parsed.deliveryAddress === "string" ? parsed.deliveryAddress : "",
  };
}
