import { GoogleGenerativeAI } from "@google/generative-ai";
import { getConversationCorpus, getProductNames, insertBotSuggestions } from "./supabaseClient";
import { logPlatformEvent } from "./logger";

// Fase 3 del bot inteligente: analiza las conversaciones recientes de UN
// restaurante y propone sugerencias (FAQ, platos mas pedidos, combinaciones,
// preferencias) que quedan en bot_suggestions con status 'pending'. NADA de
// esto cambia el comportamiento del bot hasta que el admin las aprueba en el
// panel -- solo las 'approved' se inyectan al prompt via bot_get_menu.

const apiKey = process.env.GEMINI_API_KEY;
const modelName = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

export type AnalysisResult = {
  analyzedMessages: number;
  proposed: number;
  inserted: number;
  skippedReason?: string;
};

type RawSuggestion = {
  kind?: string;
  title?: string;
  suggestion?: string;
  evidence?: Record<string, unknown>;
};

function buildAnalysisPrompt(productNames: string[], corpus: unknown[]): string {
  return `Eres un analista de datos de un restaurante. Vas a leer mensajes recientes del chat de WhatsApp entre clientes y el bot de pedidos, y vas a proponer aprendizajes UTILES y SEGUROS para mejorar las respuestas del bot.

PRODUCTOS REALES DEL RESTAURANTE (los unicos que puedes mencionar):
${productNames.map((n) => `- ${n}`).join("\n")}

MENSAJES RECIENTES (direction "inbound" = cliente, "outbound" = bot):
${JSON.stringify(corpus)}

Devuelve SOLO un JSON valido con esta forma exacta:
{"suggestions": [{"kind": "faq" | "popular_product" | "pairing" | "preference" | "rule", "title": "string corto y unico", "suggestion": "string", "evidence": {"count": 0, "examples": ["string"]}}]}

REGLAS DEL ANALISIS:
1. "suggestion" debe ser una instruccion corta y accionable PARA EL BOT, en español, ej.: "Los clientes preguntan mucho si hay delivery en Los Girasoles; la respuesta es que si, con 30-45 min de espera" o "El chicharron es lo mas pedido; cuando pidan recomendacion, mencionalo primero".
2. Solo menciona productos de la lista de PRODUCTOS REALES. Nunca inventes platos, precios ni promociones.
3. NO incluyas datos personales: nada de nombres completos, telefonos, correos ni direcciones exactas en title, suggestion ni evidence.
4. "evidence.count" = cuantas veces observaste el patron; "evidence.examples" = maximo 3 citas cortas y anonimas de clientes.
5. Maximo 6 sugerencias, solo patrones que viste AL MENOS 2 veces. Si no hay patrones claros, devuelve {"suggestions": []}.
6. No propongas cambios de precios, descuentos, ni nada que contradiga las reglas del negocio.`;
}

export async function analyzeRestaurantConversations(restaurantId: string): Promise<AnalysisResult> {
  if (!apiKey) return { analyzedMessages: 0, proposed: 0, inserted: 0, skippedReason: "GEMINI_API_KEY no configurada" };

  const corpus = await getConversationCorpus(restaurantId, 14, 600);
  if (corpus.length < 10) {
    return {
      analyzedMessages: corpus.length,
      proposed: 0,
      inserted: 0,
      skippedReason: "Muy pocas conversaciones recientes para analizar (minimo 10 mensajes en 14 dias).",
    };
  }

  const productNames = await getProductNames(restaurantId);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      maxOutputTokens: 1400,
      temperature: 0.3,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    } as Record<string, unknown>,
  });

  const result = await model.generateContent(buildAnalysisPrompt(productNames, corpus));
  const text = result.response.text();

  let parsed: { suggestions?: RawSuggestion[] } | null = null;
  try {
    parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    logPlatformEvent("warn", "bot.analysis_unparsed", "El analisis de conversaciones no devolvio JSON valido.", restaurantId);
    return { analyzedMessages: corpus.length, proposed: 0, inserted: 0, skippedReason: "El modelo no devolvio un analisis valido; intenta de nuevo." };
  }

  const clean = parsed.suggestions
    .filter((s) => s && typeof s.suggestion === "string" && s.suggestion.trim().length > 0)
    .slice(0, 8)
    .map((s) => ({
      kind: ["faq", "popular_product", "pairing", "preference", "rule"].includes(s.kind ?? "") ? s.kind : "rule",
      title: String(s.title || s.suggestion).slice(0, 160),
      suggestion: String(s.suggestion).slice(0, 600),
      evidence: s.evidence && typeof s.evidence === "object" ? s.evidence : {},
    }));

  const inserted = clean.length ? await insertBotSuggestions(restaurantId, clean) : 0;

  logPlatformEvent(
    "info",
    "bot.analysis_completed",
    `Analisis de conversaciones: ${corpus.length} mensajes revisados, ${clean.length} sugerencias propuestas, ${inserted} nuevas pendientes de aprobacion.`,
    restaurantId,
    { analyzedMessages: corpus.length, proposed: clean.length, inserted },
  );

  return { analyzedMessages: corpus.length, proposed: clean.length, inserted };
}
