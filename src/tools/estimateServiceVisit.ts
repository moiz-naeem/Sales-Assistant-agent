// This file is the tool the agent calls to price a service visit from past records.
// It checks the request, reads the records once, and hands back the estimate as plain data with an id to refer to it.

import { z } from "zod";
import { EquipmentOrOther, TaskTag } from "../domain/vocab";
import { estimate } from "../estimator/estimate";
import { serviceRecords } from "../services/records";
import { toolError } from "../agent/toolError";

export const EstimateServiceVisitInput = z.strictObject({
  report_id: z
    .string()
    .regex(/^FSR-\d{4}$/)
    .optional()
    .describe("One past report, as written by the customer, like FSR-0031. Use it when they ask about that visit."),
  equipment_model: EquipmentOrOther.optional(),
  task: TaskTag.optional(),
  currency: z.string().length(3).optional(),
  quantity: z.number().positive().optional(),
});

let counter = 0;

export function estimateServiceVisit(input: unknown) {
  const parsed = EstimateServiceVisitInput.safeParse(input);
  if (!parsed.success) return toolError("estimate_service_visit", "validation", z.prettifyError(parsed.error));
  try {
    const result = estimate(parsed.data, serviceRecords());
    return { kind: "service_estimate" as const, estimate_id: `EST-${++counter}`, result };
  } catch (error) {
    return toolError("estimate_service_visit", "runtime", error instanceof Error ? error.message : String(error));
  }
}
