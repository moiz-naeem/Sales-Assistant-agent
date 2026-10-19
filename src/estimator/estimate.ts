// This file turns the matched visits into the final estimate the salesperson sees.
// It puts the asked-for currency first, keeps the others in most-visits order, and never converts between them.

import type { Flag, ServiceRecord } from "../services/schema";
import { andList } from "../shared/text";
import { eligibleRecords, relatedVisits, type Task } from "./eligibility";
import { currencyGroups, PER_UNIT_ITEM, pricedLines } from "./groups";
import type { Tier } from "./stats";

export type EstimateRequest = {
  equipment_model?: string;
  task?: Task;
  currency?: string;
  quantity?: number;
  report_id?: string;
};

const withFlag = (records: ServiceRecord[], flag: Flag) => records.filter((r) => r.flags.includes(flag)).map((r) => r.report_id);

function limitations(request: EstimateRequest, eligible: ServiceRecord[], groups: ReturnType<typeof currencyGroups>): string[] {
  const out: string[] = [];

  if (!groups.some((g) => g.currency === request.currency) && groups.length > 0) {
    out.push(`No eligible visit is priced in ${request.currency}. Other currencies are shown as they were billed, without conversion.`);
  }

  const partNumbers = [...new Set(groups.flatMap((g) => g.parts.map((p) => p.part_number)).filter((p): p is string => p != null))];
  if (partNumbers.length > 1) {
    out.push(`The records show different cloth part numbers (${partNumbers.join(", ")}). They do not say which fits which filter size.`);
  }

  const truncated = withFlag(eligible, "truncated");
  if (truncated.length) {
    const one = truncated.length === 1;
    out.push(`${andList(truncated)} ${one ? "is" : "are"} cut off before ${one ? "its" : "their"} total. The lines ${one ? "it does" : "they do"} state are added up instead, and that sum is not a visit total.`);
  }

  const noCost = withFlag(eligible, "no_cost_stated");
  if (noCost.length) out.push(`${andList(noCost)} ${noCost.length === 1 ? "matches" : "match"} but state no cost.`);

  const suspect = withFlag(eligible, "suspect_travel_hours");
  if (suspect.length) {
    const one = suspect.length === 1;
    out.push(`${andList(suspect)} ${one ? "lists" : "list"} the same hours for travel and labour; check before relying on ${one ? "its" : "their"} travel cost.`);
  }

  const mismatch = withFlag(eligible, "arithmetic_mismatch");
  if (mismatch.length) out.push(`${andList(mismatch)} ${mismatch.length === 1 ? "has" : "have"} line items that do not add up to the stated total.`);

  const noCurrency = eligible.filter((r) => r.flags.includes("currency_unstated") && !r.flags.includes("no_cost_stated")).map((r) => r.report_id);
  if (noCurrency.length) {
    const one = noCurrency.length === 1;
    out.push(`${andList(noCurrency)} ${one ? "shows a cost" : "show costs"} but no currency, so ${one ? "it is" : "they are"} left out of the currency groups.`);
  }

  if (request.task && PER_UNIT_ITEM[request.task]) {
    const noClothCount = eligible.filter((r) => r.cloth_count == null && r.stated_total != null).map((r) => r.report_id);
    if (noClothCount.length) out.push(`${andList(noClothCount)} ${noClothCount.length === 1 ? "does" : "do"} not state how many cloths were changed.`);
  }

  if (groups.some((g) => g.totals_by_coverage.length > 1)) {
    out.push("Totals cover different things (for example tax included or not), so they are compared only within the same coverage.");
  }

  return out;
}

function missingInformation(request: EstimateRequest): string[] {
  if (request.task && PER_UNIT_ITEM[request.task] && request.quantity == null) {
    return ["The number of cloths was not given, so no per-visit total is worked out."];
  }
  return [];
}

export type ServiceEstimateResult = ReturnType<typeof estimate>;

function reportView(id: string, records: ServiceRecord[]) {
  const record = records.find((entry) => entry.report_id === id);
  if (!record) throw new Error(`No report ${id} is in our records.`);
  const { lines, total } = pricedLines(record);
  return {
    report_id: record.report_id,
    date: record.visit_date?.as_stated,
    site: record.site?.value,
    currency: record.currency?.code,
    lines,
    lines_total: total,
    stated_total: record.stated_total?.value,
    coverage: record.cost_coverage,
    flags: record.flags,
  };
}

export function estimate(request: EstimateRequest, records: ServiceRecord[]) {
  const report = request.report_id ? reportView(request.report_id, records) : undefined;
  if (!report && (!request.equipment_model || !request.task || !request.currency)) {
    throw new Error("An estimate needs a machine, a task and a currency, or one report id.");
  }
  const eligible = report ? [] : eligibleRecords(records, { equipment_model: request.equipment_model!, task: request.task! });
  const groups = currencyGroups(eligible, request);

  const count = new Map<string, number>();
  for (const r of eligible) if (r.currency) count.set(r.currency.code, (count.get(r.currency.code) ?? 0) + 1);

  const ordered = [...groups].sort((a, b) => {
    if (a.currency === request.currency) return -1;
    if (b.currency === request.currency) return 1;
    return count.get(b.currency)! - count.get(a.currency)! || a.currency.localeCompare(b.currency);
  });

  const requested = groups.find((g) => g.currency === request.currency);
  return {
    status: (report ? "limited" : (requested?.status ?? "unavailable")) as Tier,
    request,
    requested_currency_available: requested != null,
    report,
    currency_groups: ordered,
    related_visits: relatedVisits(eligible, request.task),
    limitations: limitations(request, eligible, groups),
    missing_information: missingInformation(request),
  };
}
