// This file runs one turn of the chat: ask the model, run the tools it asks for, and stop at a checked answer.
// It keeps a list of every id the tools handed back this turn, so the answer can only cite things that really came up.


import type { Content } from "@google/genai";
import { z } from "zod";
import { MAX_ITERATIONS, MAX_TOOL_CALLS_PER_ITERATION } from "../config";
import { byDocId } from "../domain/manifest";
import type * as gemini from "../llm/gemini";
import type { Trace } from "../log/trace";
import { render } from "./render";
import type { ProductEvidence } from "../retrieval/search";
import type { ServiceRecord } from "../services/schema";
import type { SubmitAnswer } from "./answer";
import { buildClarification } from "./clarify";
import { checkSlots } from "./slots";
import { toPromptJson, type SessionState } from "./state";
import { declarations, TOOLS, type ToolName } from "./tools";
import { toolError, type ToolError } from "./toolError";

export type FlotationAssessment = { assessment_id: string; dataset: { rows: number; from: string; to: string } };

export type AnswerContext = {
  evidence: Set<string>;
  user_messages: string[];
  estimates: Array<{ estimate_id: string; result: unknown }>;
  assessments: FlotationAssessment[];
  pages: ProductEvidence[];
};

export type LoopDeps = {
  generate: typeof gemini.generate;
  runTool: (name: ToolName, args: Record<string, unknown>) => unknown | Promise<unknown>;
  validateAnswer: (answer: SubmitAnswer, context: AnswerContext) => { ok: boolean; errors: string[] };
  system: string;
  records: ServiceRecord[];
};

export type Outcome = "answered" | "clarification" | "failure";
export type TurnResult = { text: string; outcome: Outcome; answer?: SubmitAnswer; trace: Trace };

const FAILED = "I couldn't put together an answer I can back up with the data.";
const NUDGE = "Please call submit_answer with your answer and its evidence ids.";

const isToolError = (value: unknown): value is ToolError =>
  typeof value === "object" && value !== null && (value as ToolError).kind === "tool_error";

function conversationContents(state: SessionState): Content[] {
  return [
    { role: "user", parts: [{ text: `Session state:\n${toPromptJson(state)}` }] },
    ...state.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.text }],
    })),
  ];
}

export async function handleMessage(state: SessionState, text: string, deps: LoopDeps): Promise<TurnResult> {
  const trace: Trace = {
    turn: state.turn_index,
    user_message: text,
    state_before: toPromptJson(state),
    iterations: [],
    slots: { grounded: [], missing: [] },
    validator: [],
    outcome: "failure",
    totals: { tokens: 0, latencyMs: 0 },
  };
  state.messages.push({ role: "user", text, turn: state.turn_index });

  const contents = conversationContents(state);
  const context: AnswerContext = {
    evidence: new Set(),
    user_messages: state.messages.filter((m) => m.role === "user").map((m) => m.text),
    estimates: [],
    assessments: [],
    pages: [],
  };
  let resubmitsLeft = 1;

  const finish = (answerText: string, outcome: Outcome, answer?: SubmitAnswer): TurnResult => {
    state.messages.push({ role: "assistant", text: answerText, turn: state.turn_index });
    state.turn_index += 1;
    trace.outcome = outcome;
    if (outcome === "clarification") trace.clarification = answerText;
    return { text: answerText, outcome, answer, trace };
  };

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const lastChance = iteration === MAX_ITERATIONS;
    let response;
    try {
      response = await deps.generate({
        system: deps.system,
        contents,
        tools: declarations(),
        toolMode: lastChance ? "ANY" : "AUTO",
        allowedTools: lastChance ? ["submit_answer"] : undefined,
      });
    } catch (error) {

      return finish(`${FAILED} The assistant could not be reached: ${message(error)}`, "failure");
    }
    const calls = response.functionCalls ?? [];
    const step = {
      usage: response.usage,
      latencyMs: response.latencyMs,
      function_calls: calls.map((call) => ({ name: String(call.name), args: call.args })),
      results_summary: [] as string[],
    };
    trace.iterations.push(step);
    trace.totals.tokens += response.usage.inputTokens + response.usage.outputTokens;
    trace.totals.latencyMs += response.latencyMs;

    if (!calls.length) {
      contents.push({ role: "model", parts: response.parts }, { role: "user", parts: [{ text: NUDGE }] });
      continue;
    }
    contents.push({ role: "model", parts: response.parts });

    const allowed = calls.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
    const replies = calls.slice(MAX_TOOL_CALLS_PER_ITERATION).map((call) => ({
      name: String(call.name),
      response: toolError(
        String(call.name),
        "budget",
        `Only ${MAX_TOOL_CALLS_PER_ITERATION} tool calls per step. Ask again in the next step.`,
      ) as object,
    }));

    // Checking happens in order, because it writes to the session; only the slow part runs together.
    const toRun = allowed.filter((c) => c.name !== "submit_answer");
    const ready = [];
    for (const call of toRun) {
      // With one tool call there is nothing else to answer from, so the question is the whole turn.
      // With two, the grounded call still answers and the model says it has nothing for the other one.
      const checked = checkCall(state, call.name as ToolName, call.args ?? {}, deps, trace, toRun.length === 1);
      if ("clarification" in checked) return finish(checked.clarification, "clarification");
      ready.push({ name: String(call.name), checked });
    }
    const results = await Promise.all(
      ready.map(({ name, checked }) =>
        "result" in checked ? checked.result : Promise.resolve(deps.runTool(name as ToolName, checked.args)),
      ),
    );
    for (const [index, result] of results.entries()) {
      remember(result, context, state);
      replies.push({ name: ready[index].name, response: result as object });
      step.results_summary.push(summarize(ready[index].name, result));
    }

    const submit = allowed.find((call) => call.name === "submit_answer");
    if (submit) {
      const parsed = TOOLS.submit_answer.schema.safeParse(submit.args ?? {});
      if (!parsed.success) {
        replies.push({
          name: "submit_answer",
          response: toolError("submit_answer", "validation", z.prettifyError(parsed.error)) as object,
        });
      } else {
        const answer = parsed.data as SubmitAnswer;
        const verdict = deps.validateAnswer(answer, context);
        // The rejected answer goes in the log too: without it there is no way to see why a quote or number failed.
        trace.validator.push({ attempt: trace.validator.length + 1, ok: verdict.ok, errors: verdict.errors, answer });
        if (verdict.ok) return finish(render(answer, context), "answered", answer);
        // One re-try is free, so a rejected answer does not eat the turn's last step. After that the turn is over.
        if (resubmitsLeft-- <= 0) return finish(failureText(context), "failure");
        replies.push({ name: "submit_answer", response: { ok: false, errors: verdict.errors } });
        iteration -= 1;
      }
    }

    contents.push({
      role: "user",
      parts: replies.map((reply) => ({
        functionResponse: { name: reply.name, response: reply.response as Record<string, unknown> },
      })),
    });
  }

  return finish(failureText(context), "failure");
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// One short line per tool result for the log, never for the screen.
function summarize(name: string, result: unknown): string {
  if (isToolError(result)) return `${name}: tool_error ${result.reason}`;
  const value = result as {
    kind?: string;
    results?: unknown[];
    found?: boolean;
    estimate_id?: string;
    assessment_id?: string;
    readings?: unknown[];
    result?: { status?: string };
  };
  if (value?.kind === "product_evidence") return `${name}: ${value.results?.length ?? 0} pages, found=${value.found}`;
  if (value?.kind === "service_estimate") return `${name}: ${value.estimate_id} ${value.result?.status}`;
  if (value?.kind === "flotation_assessment") return `${name}: ${value.assessment_id}, ${value.readings?.length ?? 0} readings`;
  return `${name}: ok`;
}

function failureText(context: AnswerContext): string {
  const found = [...context.evidence];
  return found.length ? `${FAILED} Here's what I found: ${found.join(", ")}.` : FAILED;
}

// Everything that must happen in a fixed order: the checks, and the session writes they cause.
// It never runs the tool, so the callers can start the slow ones together afterwards.
function checkCall(
  state: SessionState,
  name: ToolName,
  rawArgs: Record<string, unknown>,
  deps: LoopDeps,
  trace: Trace,
  canAsk: boolean,
): { args: Record<string, unknown> } | { result: unknown } | { clarification: string } {
  const tool = TOOLS[name];
  if (!tool) return { result: toolError(String(name), "validation", `There is no tool called ${name}.`) };

  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) return { result: toolError(name, "validation", z.prettifyError(parsed.error)) };

  const { slot_quotes, ...args } = parsed.data as Record<string, unknown> & { slot_quotes?: Record<string, string> };
  const { grounded, missing } = checkSlots(state, name, args, slot_quotes);
  trace.slots.grounded.push(...grounded);
  trace.slots.missing.push(...missing);
    if (missing.length) {
    // A field the model quoted but left empty is the model's slip, not a gap in what the customer said.
    // we xend it back to the model to fill instead of asking the customer for something they already gave.
    const quotedButUnset = missing.filter(
      (field) => slot_quotes?.[field] != null && (args[field] == null || args[field] === ""),
    );
    if (quotedButUnset.length) {
      return {
        result: toolError(
          name,
          "validation",
          `You quoted ${quotedButUnset.join(", ")} but did not set ${quotedButUnset.length === 1 ? "its value" : "their values"}. ` +
            `Map the words to our values (for task, one task tag) and set each field, then call again.`,
        ),
      };
    }
    if (!canAsk) {
      return {
        result: toolError(
          name,
          "ungrounded",
          `Missing: ${missing.join(", ")}. The customer did not give this. Do not ask for it. Answer from the tools that worked. Then tell the customer you have no information for this part.`,
        ),
      };
    }
    const asked = buildClarification(state, name, args, missing, deps.records);
    if (asked.kind === "clarification") return { clarification: asked.text };
    const why =
      asked.reason === "no_eligible_data"
        ? "No past visit matches this equipment and task, so there is nothing to price."
        : "I already asked twice, so answer with what is supported and say what is still missing.";
    return { result: toolError(name, "cap", `Still missing: ${missing.join(", ")}. ${why}`) };
  }
  return { args };
}

// Every id a tool returned this turn, so the answer validator can reject a citation nobody produced.
function remember(result: unknown, context: AnswerContext, state: SessionState) {
  if (isToolError(result) || typeof result !== "object" || result === null) return;
  const value = result as {
    kind?: string;
    results?: ProductEvidence[];
    estimate_id?: string;
    assessment_id?: string;
    result?: Record<string, unknown>;
  };

  if (value.kind === "product_evidence" && value.results) {
    const candidates = new Map(state.product_candidates.map((c) => [c.product_id, new Set(c.evidence_ids)]));
    for (const page of value.results) {
      context.evidence.add(page.evidence_id);
      context.pages.push(page);
      for (const id of byDocId(page.doc_id)?.product_ids ?? []) {
        candidates.set(id, (candidates.get(id) ?? new Set()).add(page.evidence_id));
      }
    }
    state.product_candidates = [...candidates].map(([product_id, ids]) => ({ product_id, evidence_ids: [...ids] }));
  }

  if (value.kind === "service_estimate" && value.estimate_id && value.result) {
    context.evidence.add(value.estimate_id);
    context.estimates.push({ estimate_id: value.estimate_id, result: value.result });
    const visits = (value.result.related_visits ?? []) as Array<{ report_id: string }>;
    for (const visit of visits) context.evidence.add(visit.report_id);
    state.last_estimate = { estimate_id: value.estimate_id, request: value.result.request as never };
  }

  if (value.kind === "flotation_assessment" && value.assessment_id) {
    context.evidence.add(value.assessment_id);
    context.assessments.push(result as FlotationAssessment);
  }
}
