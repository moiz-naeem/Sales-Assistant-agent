// This file checks that the facts a tool needs were really given by the customer, not guessed by the model.
// A field counts only when it has a value and a quote we can find in something the customer wrote.


import { confirmFact, type SessionState } from "./state";
import type { ToolName } from "./tools";


const READINGS = ["silica_concentrate_pct", "iron_concentrate_pct"];

const REQUIRED: Partial<Record<ToolName, (args: Record<string, unknown>) => string[]>> = {
  estimate_service_visit: (args) => (args.report_id ? ["report_id"] : ["equipment_model", "task", "currency"]),
  search_product_evidence: (args) =>
    args.intent === "recommendation" ? ["equipment_or_process", "problem_or_objective"] : ["equipment_or_process"],
  assess_flotation_readings: (args) => {
    const given = READINGS.filter((field) => args[field] != null);
    return given.length ? given : READINGS;
  },
};

const alreadyConfirmed = (state: SessionState, field: string, value: string) =>
  state.confirmed_facts.some((fact) => fact.field === field && fact.value === value);

export function checkSlots(
  state: SessionState,
  tool: ToolName,
  args: Record<string, unknown>,
  slotQuotes: Record<string, string> = {},
): { grounded: string[]; missing: string[] } {
  const grounded: string[] = [];
  const missing: string[] = [];

  for (const field of REQUIRED[tool]?.(args) ?? []) {
    const value = args[field];
    if (value == null || value === "") {
      missing.push(field);
      continue;
    }
    const text = String(value);
    const quote = slotQuotes[field];
    const ok = (quote != null && confirmFact(state, field, text, quote)) || alreadyConfirmed(state, field, text);
    (ok ? grounded : missing).push(field);
  }
  if (!missing.length && state.pending_clarification?.tool === tool) state.pending_clarification = undefined;
  return { grounded, missing };
}
