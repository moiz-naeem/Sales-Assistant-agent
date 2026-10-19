// This file is the tool the agent calls to look up product facts in the brochures.
// It checks the request, runs the search, and hands back the pages as plain data, with no instructions added.

import { z } from "zod";
import { MIN_EVIDENCE_SCORE } from "../config";
import { byDocId, manifest, ProductFamily } from "../domain/manifest";
import { EquipmentModel } from "../domain/vocab";
import { search, type ProductEvidence } from "../retrieval/search";
import { toolError } from "../agent/toolError";

export const SearchProductEvidenceInput = z.strictObject({
  intent: z
    .enum(["fact", "recommendation"])
    .describe("'fact' for a plain question about equipment. 'recommendation' when suggesting something for a customer's problem."),
  equipment_or_process: z
    .string()
    .min(2)
    .describe("The equipment or process the question is about, in the customer's own words, for example 'Larox pressure filters'."),
  problem_or_objective: z
    .string()
    .min(2)
    .optional()
    .describe("What the customer is trying to achieve or fix. Required when intent is 'recommendation'."),
  query: z.string().min(3).describe("The words to search the brochures for."),
  product_family: ProductFamily.optional(),
  doc_id: z.enum(manifest.map((entry) => entry.doc_id) as [string, ...string[]]).optional(),
  product_id: EquipmentModel.optional(),
});

export async function searchProductEvidence(input: unknown, options: { indexDir?: string } = {}) {
  const parsed = SearchProductEvidenceInput.safeParse(input);
  if (!parsed.success) return toolError("search_product_evidence", "validation", z.prettifyError(parsed.error));
  const { query, intent, equipment_or_process, problem_or_objective, ...filters } = parsed.data;
  try {
    const results = await search(query, { ...filters, ...options });
    return {
      kind: "product_evidence" as const,
      query,
      filters,
      results,
      found: (results[0]?.score ?? 0) >= MIN_EVIDENCE_SCORE,
      editions_present: editionsPresent(results),
    };
  } catch (error) {
    return toolError("search_product_evidence", "runtime", error instanceof Error ? error.message : String(error));
  }
}

function editionsPresent(results: ProductEvidence[]): Record<string, string[]> {
  const editions = new Map<string, Set<string>>();
  for (const result of results) {
    for (const productId of byDocId(result.doc_id)?.product_ids ?? []) {
      if (!editions.has(productId)) editions.set(productId, new Set());
      editions.get(productId)!.add(result.edition);
    }
  }
  return Object.fromEntries([...editions].filter(([, set]) => set.size > 1).map(([id, set]) => [id, [...set]]));
}
