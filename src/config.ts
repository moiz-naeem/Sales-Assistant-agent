// This file keeps all our settings in one place.
// It reads the .env file, checks the values, and holds the fixed numbers the agent uses.

import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile();

const Env = z.object({
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
  GEMINI_EMBED_MODEL: z.string().default("gemini-embedding-001"),
});


const setValues = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value));

export const env = Object.freeze(Env.parse(setValues));

export function geminiApiKey(): string {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing. Copy .env.example to .env and add your Gemini key.");
  }
  return env.GEMINI_API_KEY;
}

export const TEMPERATURE = 0;

export const SEED = 42;
export const MAX_ITERATIONS = 4;
export const MAX_TOOL_CALLS_PER_ITERATION = 3;
export const CLARIFICATION_CAP = 2;
export const CHILD_MIN = 600;
export const CHILD_MAX = 800;
export const PARENT_CAP = 4000;
export const RRF_K = 60;
export const TOP_K = 5;
export const CANDIDATES_PER_RETRIEVER = 20;

export const MIN_EVIDENCE_SCORE = 0.02;
export const INDEX_DIR = "knowledge/lancedb";
