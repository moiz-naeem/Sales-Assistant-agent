// This file sorts the matching visits into one group per currency. It never converts between currencies.

import type { LineItem, ServiceRecord } from "../services/schema";
import { extraScope, type Task } from "./eligibility";
import { stats, tier, type Tier } from "./stats";

export const PER_UNIT_ITEM: Partial<Record<Task, LineItem["kind"]>> = { filter_cloth_replacement: "filter_cloth" };

const RANK: Tier[] = ["unavailable", "limited", "sufficient"];
const cents = (amount: number) => Math.round(amount * 100);
const money = (amountCents: number) => amountCents / 100;

function inMoney(s: ReturnType<typeof stats>) {
  const spread = { n: s.n, median: money(s.median), min: money(s.min), max: money(s.max) };
  return "q1" in s ? { ...spread, q1: money(s.q1), q3: money(s.q3), quartile_method: s.quartile_method } : spread;
}

const times = (quantity: number, rateCents: number) => ({
  formula: `${quantity} × ${money(rateCents).toFixed(2)}`,
  result: money(Math.round(quantity * rateCents)),
});

function partGroups(records: ServiceRecord[], item: LineItem["kind"], quantity?: number) {
  const groups = new Map<string | null, Array<{ report_id: string; rate: number; quote: string }>>();
  for (const record of records) {
    for (const line of record.line_items) {
      if (line.kind !== item || line.rate == null) continue;
      const key = line.part_number ?? null;
      groups.set(key, [...(groups.get(key) ?? []), { report_id: record.report_id, rate: line.rate, quote: line.quote }]);
    }
  }
  return [...groups].map(([part_number, unit_prices]) => {
    const s = stats(unit_prices.map((price) => cents(price.rate)));
    const computation =
      quantity == null
        ? undefined
        : {
            ...times(quantity, s.median),
            source_lines: unit_prices.map((price) => price.quote),
            ...(s.n >= 2 && { min: times(quantity, s.min), max: times(quantity, s.max) }),
          };
    return { part_number, unit_prices, ...(s.n >= 2 ? inMoney(s) : { n: s.n }), ...(computation && { computation }) };
  });
}

export function pricedLines(record: ServiceRecord) {
  const lines = record.line_items.flatMap((line) => {
    const computed = line.qty != null && line.rate != null ? times(line.qty, cents(line.rate)) : undefined;
    const amount = line.line_total ?? computed?.result;
    if (amount == null) return [];
    return [{ description: line.description, ...(line.line_total == null && { formula: computed!.formula }), amount }];
  });
  return { lines, total: money(lines.reduce((sum, line) => sum + cents(line.amount), 0)) };
}

function lineSums(records: ServiceRecord[]) {
  return records
    .filter((record) => !record.stated_total)
    .map((record) => ({
      report_id: record.report_id,
      date: record.visit_date?.as_stated,
      truncated: record.flags.includes("truncated"),
      coverage: record.cost_coverage,
      ...pricedLines(record),
    }))
    .filter((sum) => sum.lines.length > 0);
}

function totalsByCoverage(visitTotals: Array<{ stated_total: number; coverage: ServiceRecord["cost_coverage"] }>) {
  const groups = new Map<string, typeof visitTotals>();
  for (const visit of visitTotals) {
    const { labour, travel, parts, tax } = visit.coverage;
    const key = [labour, travel, parts, tax].join("/");
    groups.set(key, [...(groups.get(key) ?? []), visit]);
  }
  return [...groups.values()].map((list) => {
    const s = stats(list.map((visit) => cents(visit.stated_total)));
    return { coverage: list[0].coverage, n: s.n, status: tier(s.n), ...(s.n >= 2 && { stats: inMoney(s) }) };
  });
}

export function currencyGroups(eligible: ServiceRecord[], request: { task?: Task; quantity?: number }) {
  const byCurrency = new Map<string, ServiceRecord[]>();
  for (const record of eligible) {
    if (record.currency) byCurrency.set(record.currency.code, [...(byCurrency.get(record.currency.code) ?? []), record]);
  }
  const item = request.task ? PER_UNIT_ITEM[request.task] : undefined;
  return [...byCurrency].map(([currency, records]) => {
    const parts = item ? partGroups(records, item, request.quantity) : [];
    const visit_totals = records
      .filter((record) => record.stated_total)
      .map((record) => ({
        report_id: record.report_id,
        date: record.visit_date?.as_stated,
        stated_total: record.stated_total!.value,
        subtotal_ex_tax: record.subtotal_ex_tax?.value,
        coverage: record.cost_coverage,
        cloth_count: record.cloth_count?.value,
        extra_scope: extraScope(record, request.task),
      }));
    const totals_by_coverage = totalsByCoverage(visit_totals);
    const best = Math.max(0, ...[...parts.map((part) => tier(part.n)), ...totals_by_coverage.map((group) => group.status)].map((t) => RANK.indexOf(t)));
    return { currency, status: RANK[best], parts, visit_totals, line_sums: lineSums(records), totals_by_coverage };
  });
}
