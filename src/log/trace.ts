// This file keeps a quiet record of every turn, one line of JSON per turn, in a file named after the day.

import { appendFileSync, mkdirSync } from "node:fs";
import type { Outcome } from "../agent/loop";

export type Trace = {
  turn: number;
  user_message: string;
  state_before: string;
  iterations: Array<{
    usage: { inputTokens: number; outputTokens: number };
    latencyMs: number;
    function_calls: Array<{ name: string; args?: unknown }>;
    results_summary: string[];
  }>;
  slots: { grounded: string[]; missing: string[] };
  clarification?: string;
  validator: Array<{ attempt: number; ok: boolean; errors: string[]; answer?: unknown }>;
  outcome: Outcome;
  totals: { tokens: number; latencyMs: number };
};

export function writeTrace(trace: Trace, dir = "logs") {
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(`${dir}/${day}.jsonl`, `${JSON.stringify(trace)}\n`, "utf8");
}
