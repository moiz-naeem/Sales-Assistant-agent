// This file remembers one chat: what was said, what the customer told us, and what the agent is still waiting for.
// A fact is kept only when the customer's own words contain it, so the agent can never invent one.


import { EquipmentModel } from "../domain/vocab";
import type { EstimateRequest } from "../estimator/estimate";
import { normalizeText } from "../shared/text";

export type ConfirmedFact = {
  field: string;
  value: string;
  source_quote: string;
  turn: number;
  replaced?: { value: string; turn: number }[];
};

export type SessionState = {
  turn_index: number;
  messages: Array<{ role: "user" | "assistant"; text: string; turn: number }>;
  confirmed_facts: ConfirmedFact[];
  pending_clarification?: { tool: string; partial_args: object; missing_fields: string[]; attempts: number };
  last_estimate?: { estimate_id: string; request: EstimateRequest };
  product_candidates: Array<{ product_id: string; evidence_ids: string[] }>;
};

export const newSession = (): SessionState => ({ turn_index: 0, messages: [], confirmed_facts: [], product_candidates: [] });

const forMatching = (text: string) => normalizeText(text).toLowerCase();

const MIN_QUOTE_CHARS = 4;
const CURRENCY_SIGNS: Record<string, string> = { EUR: "€" };

const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const surfaceForms = (id: string) => {
  const whole = letters(id);
  const withoutBrand = letters(id.split("_").slice(1).join("_"));
  return withoutBrand.length >= 3 && withoutBrand !== whole ? [whole, withoutBrand] : [whole];
};

function namesOneMachine(value: string, message: string): boolean {
  const said = letters(message);
  if (value.startsWith("other:")) return said.includes(letters(value.slice("other:".length)));

  let best = { id: "", length: 0 };
  for (const id of EquipmentModel.options) {
    for (const form of surfaceForms(id)) {
      if (said.includes(form) && form.length > best.length) best = { id, length: form.length };
    }
  }
  return best.id === value;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

function carriesValue(field: string, value: string, needle: string, message: string): boolean {
  if (field === "equipment_model") return namesOneMachine(value, message);
  if (NUMBER.test(value)) return new RegExp(`(^|[^\\d.])${value.replace(".", "\\.")}([^\\d]|$)`).test(needle);
  if (field === "report_id") return needle.includes(value.toLowerCase());
  if (field !== "currency") return needle.length >= MIN_QUOTE_CHARS;
  const sign = CURRENCY_SIGNS[value.toUpperCase()];
  return needle.includes(value.toLowerCase()) || (sign != null && needle.includes(sign));
}

export function confirmFact(state: SessionState, field: string, value: string, quote: string): boolean {
  const needle = forMatching(quote);
  if (!needle) return false;
  const said = state.messages.find((m) => m.role === "user" && forMatching(m.text).includes(needle));
  if (!said || !carriesValue(field, value, needle, forMatching(said.text))) return false;

  const existing = state.confirmed_facts.find((fact) => fact.field === field);
  if (!existing) {
    state.confirmed_facts.push({ field, value, source_quote: quote, turn: state.turn_index });
    return true;
  }
  if (existing.value !== value) existing.replaced = [...(existing.replaced ?? []), { value: existing.value, turn: existing.turn }];
  existing.value = value;
  existing.source_quote = quote;
  existing.turn = state.turn_index;
  return true;
}

export function toPromptJson(state: SessionState): string {
  return JSON.stringify({
    turn: state.turn_index,
    facts: state.confirmed_facts.map(({ field, value, turn, replaced }) => ({ field, value, turn, ...(replaced && { replaced }) })),
    pending_clarification: state.pending_clarification,
    last_estimate_id: state.last_estimate?.estimate_id,
    product_candidates: state.product_candidates,
    recent_user_messages: state.messages.filter((m) => m.role === "user").slice(-2).map((m) => m.text),
  });
}
