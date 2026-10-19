// This script checks how well brochure search finds the right pages. Run it with: npm run eval:retrieval
// It runs every hand-labelled query in retrieval.jsonl through the search tool and prints recall@5 and MRR.


import { readFileSync } from "node:fs";
import { searchProductEvidence } from "../src/tools/searchProductEvidence";

type Case = { id: string; query: string; filters?: Record<string, string>; expected_parents: string[] };

const cases: Case[] = readFileSync(new URL("./retrieval.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const recalls: number[] = [];
const reciprocalRanks: number[] = [];

for (const c of cases) {
  
  const result = await searchProductEvidence({ intent: "fact", equipment_or_process: c.query, query: c.query, ...c.filters });
  if (result.kind === "tool_error") throw new Error(`${c.id}: ${result.message}`);
  const found = result.results.map((evidence) => evidence.evidence_id);
  const top = result.results.map((evidence) => `${evidence.evidence_id} (${evidence.score.toFixed(4)})`).join(", ");

  if (!c.expected_parents.length) {
    console.log(`${c.id}  no answer expected  found: ${result.found}  top: ${top || "nothing"}`);
    continue;
  }
  const rank = found.findIndex((id) => c.expected_parents.includes(id)) + 1;
  const recall = c.expected_parents.filter((id) => found.includes(id)).length / c.expected_parents.length;
  recalls.push(recall);
  reciprocalRanks.push(rank ? 1 / rank : 0);
  console.log(`${c.id}  found: ${result.found}  first relevant rank: ${rank || "miss"}  recall@5: ${recall.toFixed(2)}  top: ${top}`);
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
console.log(`\n${recalls.length} scored queries  recall@5: ${mean(recalls).toFixed(3)}  MRR: ${mean(reciprocalRanks).toFixed(3)}`);
