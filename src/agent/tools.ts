// This file lists the only four tools the model may call, and turns each one's checks into a Gemini declaration.
// Every tool is read-only. The model also sends a short quote per slot, which is how we know the customer really said it.

import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { assessFlotationReadings, AssessFlotationReadingsInput } from "../tools/assessFlotation";
import { estimateServiceVisit, EstimateServiceVisitInput } from "../tools/estimateServiceVisit";
import { searchProductEvidence, SearchProductEvidenceInput } from "../tools/searchProductEvidence";
import { SubmitAnswer } from "./answer";

export type ToolName =
  | "search_product_evidence"
  | "estimate_service_visit"
  | "assess_flotation_readings"
  | "submit_answer";

const SlotQuotes = z
  .record(z.string(), z.string())
  .describe(
    "The customer's own words behind every required value, keyed by field name, copied exactly from their message. Needed even for values you translate into our vocabulary: for task, quote the words describing the work. Without them the field counts as missing and the customer is asked again.",
  );

export const TOOLS = {
  search_product_evidence: {
    description:
      "Look up product facts in the Metso brochures. Use it for anything about equipment or processes. Returns brochure pages with their ids; it never answers on its own.",
    schema: SearchProductEvidenceInput.extend({ slot_quotes: SlotQuotes }),
    run: searchProductEvidence,
  },
  estimate_service_visit: {
    description:
      "Price a service visit from past service reports. It groups by currency and part number and never converts between currencies. You must never work costs out yourself. When the customer names one report, send report_id and nothing else: the answer then covers that visit alone.",
    schema: EstimateServiceVisitInput.extend({ slot_quotes: SlotQuotes }),
    run: estimateServiceVisit,
  },
  assess_flotation_readings: {
    description:
      "Compare a customer's silica and iron concentrate percentages with the hours one iron ore plant logged in 2017. Returns percentiles, how often that plant did worse, its quartiles, what moved with silica, and the warnings to repeat.",
    schema: AssessFlotationReadingsInput.extend({ slot_quotes: SlotQuotes }),
    run: assessFlotationReadings,
  },
  submit_answer: {
    description:
      "Hand in the final answer. Every claim must carry the evidence ids it comes from. This is always the last call of a turn.",
    schema: SubmitAnswer,
  },
} satisfies Record<ToolName, { description: string; schema: z.ZodObject; run?: (args: never) => unknown }>;

export const declarations = (): FunctionDeclaration[] =>
  Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    parametersJsonSchema: z.toJSONSchema(tool.schema, { io: "input" }),
  }));
