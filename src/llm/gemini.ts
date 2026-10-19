// This file is our only door to Gemini.
// It lets us chat with tools, get JSON that matches a schema, and turn text into embeddings.

import { ApiError, FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import type { Content, FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { env, geminiApiKey, SEED, TEMPERATURE } from "../config";

export class LlmError extends Error {
  constructor(
    public kind: "api" | "parse" | "rate_limit",
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

let client: GoogleGenAI | undefined;
const ai = () => (client ??= new GoogleGenAI({ apiKey: geminiApiKey() }));

async function call<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiError) throw new LlmError(error.status === 429 ? "rate_limit" : "api", error.message);
    throw new LlmError("api", error instanceof Error ? error.message : String(error));
  }
}

export async function generate(options: {
  system: string;
  contents: Content[];
  tools?: FunctionDeclaration[];
  toolMode?: "AUTO" | "ANY";
  allowedTools?: string[];
}) {
  const started = Date.now();
  const response = await call(() =>
    ai().models.generateContent({
      model: env.GEMINI_MODEL,
      contents: options.contents,
      config: {
        systemInstruction: options.system,
        temperature: TEMPERATURE,
        tools: options.tools && [{ functionDeclarations: options.tools }],
        toolConfig: options.tools && {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode[options.toolMode ?? "AUTO"],
            allowedFunctionNames: options.allowedTools,
          },
        },
      },
    }),
  );
  return {
    parts: response.candidates?.[0]?.content?.parts ?? [],
    functionCalls: response.functionCalls ?? [],
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
    latencyMs: Date.now() - started,
  };
}

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

export async function generateStructured<T>(options: { system: string; prompt: string; schema: z.ZodType<T> }) {
  let prompt = options.prompt;
  let lastError = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await call(() =>
      ai().models.generateContent({
        model: env.GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction: options.system,
          temperature: TEMPERATURE,
          seed: SEED,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(options.schema),
        },
      }),
    );
    usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
    usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
    const parsed = options.schema.safeParse(parseJson(response.text));
    if (parsed.success) return { data: parsed.data, usage, attempts: attempt };
    lastError = parsed.error.message;
    prompt = `${options.prompt}\n\nYour last answer did not match the schema:\n${lastError}\nPlease answer again.`;
  }
  throw new LlmError("parse", `Gemini's answer did not match the schema after a retry: ${lastError}`);
}

const EMBED_BATCH = 100;

export async function embed(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const response = await call(() =>
      ai().models.embedContent({
        model: env.GEMINI_EMBED_MODEL,
        contents: texts.slice(start, start + EMBED_BATCH),
        config: { taskType },
      }),
    );
    for (const embedding of response.embeddings ?? []) {
      if (!embedding.values) throw new LlmError("api", "Gemini returned an embedding with no values.");
      vectors.push(embedding.values);
    }
  }
  if (vectors.length !== texts.length) {
    throw new LlmError("api", `Asked for ${texts.length} embeddings but got ${vectors.length}.`);
  }
  return vectors;
}
