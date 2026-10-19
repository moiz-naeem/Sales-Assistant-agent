// This file does a quick look before the agent answers, so one clarification message can ask everything that matters.

import type { ServiceRecord } from "../services/schema";
import { eligibleRecords } from "./eligibility";
import type { EstimateRequest } from "./estimate";
import { PER_UNIT_ITEM } from "./groups";

export function dryRun(partial: Partial<EstimateRequest>, records: ServiceRecord[]) {
  const eligible =
    partial.equipment_model && partial.task
      ? eligibleRecords(records, { equipment_model: partial.equipment_model, task: partial.task })
      : [];
  const currencies_available = [...new Set(eligible.flatMap((r) => (r.currency ? [r.currency.code] : [])))].sort();
  return {
    eligible_count: eligible.length,
    currencies_available,
    needs_quantity: partial.task != null && PER_UNIT_ITEM[partial.task] != null && partial.quantity == null,
    outcome_independent_of_currency: currencies_available.length <= 1,
  };
}
