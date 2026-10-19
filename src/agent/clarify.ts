// This file writes the one question the agent asks when something is missing.
// The wording comes from fixed templates and the choices come from the records, so the agent never guesses.
// If no past visit matches at all, there is nothing to choose, so it does not ask about the currency.

import { CLARIFICATION_CAP } from "../config";
import { dryRun } from "../estimator/dryRun";
import type { Task } from "../estimator/eligibility";
import type { ServiceRecord } from "../services/schema";
import { andList } from "../shared/text";
import type { SessionState } from "./state";
import type { ToolName } from "./tools";

export type ClarifyResult =
  | { kind: "clarification"; text: string }
  | { kind: "no_question"; reason: "cap" | "no_eligible_data" | "nothing_to_ask" };

const QUESTIONS: Record<string, string> = {
  equipment_model: "Which machine is this for? (for example a Larox PF-DS)",
  task: "What work is being done? (for example a filter cloth change)",
  currency: "Which currency should I price it in?",
  report_id: "Which report number do you mean? (for example FSR-0027)",
  equipment_or_process: "Which equipment or process do you mean?",
  problem_or_objective: "What are you trying to achieve?",
  silica_concentrate_pct: "What percentage of silica are they seeing in the concentrate?",
  iron_concentrate_pct: "And what percentage of iron?",
};

export function buildClarification(
  state: SessionState,
  tool: ToolName,
  args: Record<string, unknown>,
  missing: string[],
  records: ServiceRecord[],
): ClarifyResult {
  const attempts = state.pending_clarification?.tool === tool ? state.pending_clarification.attempts : 0;
  if (attempts >= CLARIFICATION_CAP) return { kind: "no_question", reason: "cap" };

  const look =
    tool === "estimate_service_visit" && !args.report_id
      ? dryRun(
          {
            equipment_model: args.equipment_model as string | undefined,
            task: args.task as Task | undefined,
            quantity: args.quantity as number | undefined,
          },
          records,
        )
      : undefined;
  if (look?.eligible_count === 0) return { kind: "no_question", reason: "no_eligible_data" };

  const questions = missing.map((field) =>
    field === "currency" && look?.currencies_available.length
      ? `The matching visits were billed in ${andList(look.currencies_available)}. Which currency should I use?`
      : (QUESTIONS[field] ?? `Please tell me the ${field.replace(/_/g, " ")}.`),
  );
  if (look?.needs_quantity) questions.push("How many cloths are being changed?");
  if (!questions.length) return { kind: "no_question", reason: "nothing_to_ask" };

  state.pending_clarification = { tool, partial_args: args, missing_fields: missing, attempts: attempts + 1 };
  return {
    kind: "clarification",
    text:
      questions.length === 1
        ? questions[0]
        : `I need a little more before I can answer:\n${questions.map((q) => `- ${q}`).join("\n")}`,
  };
}
