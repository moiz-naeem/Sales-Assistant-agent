// This script marks the agent's homework. It replays twenty saved conversations three times each,
// checks what the agent did against what we expect, and prints one scorecard at the end.


import { readFileSync } from "node:fs";
import { z } from "zod";
import { handleMessage, type LoopDeps } from "../src/agent/loop";
import { SYSTEM_PROMPT } from "../src/agent/prompt";
import { newSession } from "../src/agent/state";
import type { ToolName } from "../src/agent/tools";
import { validateAnswer } from "../src/agent/validateAnswer";
import { INDEX_DIR } from "../src/config";
import { generate, generateStructured } from "../src/llm/gemini";
import { serviceRecords } from "../src/services/records";
import { numbersIn } from "../src/shared/numbers";
import { assessFlotationReadings } from "../src/tools/assessFlotation";
import { estimateServiceVisit } from "../src/tools/estimateServiceVisit";
import { searchProductEvidence } from "../src/tools/searchProductEvidence";
import type { Trace } from "../src/log/trace";

const RUNS = 3;
const AT_K = 5;
const AT_ONCE = 4;
const FIXTURES = "eval/fixtures/lancedb";

type Expect = {
  route: string[];
  clarification_fields: string[];
  expected_parents: string[];
  expected_reports: string[];
  expected_numbers: number[];
  should_abstain: boolean;
  must_not_contain: string[];
  judge: boolean;
};
type Case = { id: string; category: string; index: "real" | "fixtures"; turns: Array<{ user: string; expect: Expect }> };

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;

const cases: Case[] = readFileSync("eval/golden.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((testCase: Case) => !only || testCase.id === only);

const ABSTAINS =
  /(no|not|n't)\s+(\w+\s+){0,3}(record|data|information|cover|have|include|contain|list|provide)|do(es)? not cover|cannot provide|unable to|outside what/i;

const cents = (n: number) => Math.round(n * 100);

type Seen = { tools: string[]; parents: string[] };

function depsFor(indexDir: string, seen: Seen): LoopDeps {
  return {
    generate,
    runTool: async (name: ToolName, args: Record<string, unknown>) => {
      seen.tools.push(name);
      if (name === "search_product_evidence") {
        const out = await searchProductEvidence(args, { indexDir });
        if ("results" in out) for (const page of out.results) seen.parents.push(page.evidence_id);
        return out;
      }
      if (name === "assess_flotation_readings") return assessFlotationReadings(args);
      return estimateServiceVisit(args);
    },
    validateAnswer,
    system: SYSTEM_PROMPT,
    records: serviceRecords(),
  };
}

const Judgement = z.object({ follows: z.boolean(), reason: z.string() });

async function judgeGrounding(link: { customer_need_quote: string; brochure_quote: string; link_statement: string }) {
  try {
    const { data } = await generateStructured({
      system: "You check one sentence of sales reasoning. Judge only from the two quotes you are given.",
      prompt:
        `The customer said: "${link.customer_need_quote}"\n` +
        `The brochure says: "${link.brochure_quote}"\n` +
        `The salesperson concluded: "${link.link_statement}"\n\n` +
        "Does the conclusion follow from those two quotes alone, adding no claim the brochure does not make?",
      schema: Judgement,
    });
    return data?.follows === true;
  } catch {
    return null;
  }
}

type TurnScore = {
  routing: boolean;
  clarification: boolean;
  numbers: boolean;
  abstention: boolean;
  safety: boolean;
  recall: number | null;
  rr: number | null;
  grounding: boolean | null;
  tokens: number;
  latencyMs: number;
};

type Answer = { claims?: unknown[]; recommendation?: { reasoning_link: Parameters<typeof judgeGrounding>[0] } };

async function scoreTurn(want: Expect, said: string, trace: Trace, seen: Seen, answer?: Answer): Promise<TurnScore> {
  const ranked = [...new Set(seen.parents)];
  const topK = ranked.slice(0, AT_K);
  const hits = want.expected_parents.filter((id) => topK.includes(id));
  const firstHit = ranked.findIndex((id) => want.expected_parents.includes(id));

  const spoken = new Set(numbersIn(said).map(cents));
  const allReported = want.expected_numbers.every((n) => spoken.has(cents(n)));
  const validatorOk = trace.validator.length === 0 || trace.validator.at(-1)?.ok === true;

  const askedFor = [...new Set(trace.slots.missing)];
  const isClarification = trace.outcome === "clarification";

  const answered = want.expected_numbers.length > 0 && allReported;
  const abstained = (answer?.claims?.length ?? 0) === 0 || ABSTAINS.test(said);

  return {
    routing: [...new Set(seen.tools)].sort().join(",") === [...want.route].sort().join(","),
    clarification: want.clarification_fields.length
      ? isClarification && want.clarification_fields.every((field) => askedFor.includes(field))
      : !isClarification,
    numbers: allReported && validatorOk,
    abstention: isClarification || answered || abstained === want.should_abstain,
    safety: !want.must_not_contain.some((bad) => said.toLowerCase().includes(bad.toLowerCase())),
    recall: want.expected_parents.length ? hits.length / want.expected_parents.length : null,
    rr: want.expected_parents.length ? (firstHit === -1 ? 0 : 1 / (firstHit + 1)) : null,
    grounding: want.judge && answer?.recommendation ? await judgeGrounding(answer.recommendation.reasoning_link) : null,
    tokens: trace.totals.tokens,
    latencyMs: trace.totals.latencyMs,
  };
}

async function runOnce(testCase: Case): Promise<TurnScore[]> {
  const state = newSession();
  const scores: TurnScore[] = [];
  for (const turn of testCase.turns) {
    const seen: Seen = { tools: [], parents: [] };
    const deps = depsFor(testCase.index === "fixtures" ? FIXTURES : INDEX_DIR, seen);
    const result = await handleMessage(state, turn.user, deps);
    const score = await scoreTurn(turn.expect, result.text, result.trace, seen, result.answer as Answer | undefined);
    if (only) {
      console.log(`\n--- ${testCase.id} | you> ${turn.user}`);
      console.log(`outcome=${result.trace.outcome} tools=[${seen.tools}] missing=[${result.trace.slots.missing}]`);
      console.log(`pages=[${[...new Set(seen.parents)].slice(0, AT_K)}]`);
      console.log(`validator=${JSON.stringify(result.trace.validator.map((v) => ({ ok: v.ok, errors: v.errors })))}`);
      console.log(`failed=[${METRICS.filter((m) => !score[m])}]`);
      console.log(`assistant> ${result.text}`);
    }
    scores.push(score);
  }
  return scores;
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i]);
    }),
  );
  return out;
}

const METRICS = ["routing", "clarification", "numbers", "abstention", "safety"] as const;
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(0)}%` : "n/a");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const runs = only ? 1 : RUNS;
const units = cases.flatMap((testCase) => Array.from({ length: runs }, () => testCase));
const started = Date.now();
const results = await pool(units, AT_ONCE, async (testCase) => ({ testCase, scores: await runOnce(testCase) }));

const passed = (scores: TurnScore[]) =>
  scores.every((s) => METRICS.every((m) => s[m]) && s.grounding !== false);

const byCase = new Map<string, { testCase: Case; runs: TurnScore[][] }>();
for (const { testCase, scores } of results) {
  if (!byCase.has(testCase.id)) byCase.set(testCase.id, { testCase, runs: [] });
  byCase.get(testCase.id)!.runs.push(scores);
}

const turns = results.flatMap((r) => r.scores);
const recall = mean(turns.map((t) => t.recall).filter((v): v is number => v !== null));
const mrr = mean(turns.map((t) => t.rr).filter((v): v is number => v !== null));
const judged = turns.map((t) => t.grounding).filter((v): v is boolean => v !== null);

console.log(`\nGolden set: ${cases.length} cases x ${runs} runs = ${results.length} conversations, ${turns.length} turns`);
console.log(`Wall clock ${((Date.now() - started) / 60000).toFixed(1)} min\n`);

console.log("Per metric (share of turns that pass)");
for (const metric of METRICS) console.log(`  ${metric.padEnd(14)} ${pct(turns.filter((t) => t[metric]).length, turns.length)}`);
console.log(`  recall@${AT_K}       ${recall?.toFixed(3) ?? "n/a"}`);
console.log(`  MRR            ${mrr?.toFixed(3) ?? "n/a"}`);
console.log(`  grounding      ${judged.length ? pct(judged.filter(Boolean).length, judged.length) : "n/a"} (indicative, ${judged.length} judged)\n`);

console.log("Per category (pass@3 = at least one run passes, pass^3 = all three pass)");
const all = [...byCase.values()];
for (const category of [...new Set(cases.map((c) => c.category))]) {
  const inCategory = all.filter((entry) => entry.testCase.category === category);
  const at3 = inCategory.filter((entry) => entry.runs.some(passed)).length;
  const pow3 = inCategory.filter((entry) => entry.runs.every(passed)).length;
  console.log(`  ${category.padEnd(14)} pass@3 ${at3}/${inCategory.length}   pass^3 ${pow3}/${inCategory.length}`);
}
console.log(
  `  ${"TOTAL".padEnd(14)} pass@3 ${all.filter((e) => e.runs.some(passed)).length}/${all.length}   pass^3 ${all.filter((e) => e.runs.every(passed)).length}/${all.length}\n`,
);

const flaky = all.filter((e) => e.runs.some(passed) && !e.runs.every(passed));
const broken = all.filter((e) => !e.runs.some(passed));
console.log(`Flaky (passes sometimes): ${flaky.map((e) => e.testCase.id).join(", ") || "none"}`);
console.log(`Failing every run: ${broken.map((e) => e.testCase.id).join(", ") || "none"}\n`);

for (const entry of [...flaky, ...broken]) {
  const why = new Set<string>();
  for (const run of entry.runs) {
    for (const score of run) {
      for (const metric of METRICS) if (!score[metric]) why.add(metric);
      if (score.grounding === false) why.add("grounding");
    }
  }
  console.log(`  ${entry.testCase.id.padEnd(30)} fails: ${[...why].join(", ")}`);
}

const perTurn = turns.length || 1;
console.log(
  `\nAverage per turn: ${Math.round(turns.reduce((n, t) => n + t.tokens, 0) / perTurn)} tokens, ${Math.round(turns.reduce((n, t) => n + t.latencyMs, 0) / perTurn)} ms`,
);
