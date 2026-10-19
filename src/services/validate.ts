// This file checks one extracted service record against its original report.
// It never changes a value. It only says which flags apply and which errors need fixing.

import { numbersIn } from "../shared/numbers";
import { normalizeText } from "../shared/text";
import type { Flag, LineItem, ServiceRecord } from "./schema";

const cents = (amount: number) => Math.round(amount * 100);
const MONEY = /[$€]\s?\d|\d,\d{3}|\d\.\d{2}\b|\b[A-Z]{3}\s?\$?\d/;
const differs = (actual: number, expected: number) =>
  Math.abs(actual - expected) > Math.max(1, Math.abs(expected) * 0.005);

function quotesIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(quotesIn);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    key === "quote" && typeof inner === "string" ? [inner] : quotesIn(inner),
  );
}

function isTruncated(fileText: string): boolean {
  const lines = fileText.split("\n").map((line) => line.trim());
  if (lines.some((line) => line.startsWith("|") && !line.endsWith("|"))) return true;
  const costHeading = lines.findIndex((line) => /cost summary/i.test(line));
  return costHeading >= 0 && !lines.slice(costHeading + 1).some((line) => /total/i.test(line) && /\d/.test(line));
}

function hasArithmeticMismatch(record: ServiceRecord): boolean {
  const lineWrong = record.line_items.some(
    (item) =>
      item.qty != null &&
      item.rate != null &&
      item.line_total != null &&
      item.rate !== item.line_total &&
      differs(cents(item.qty * item.rate), cents(item.line_total)),
  );
  const totals = record.line_items.filter((item) => item.kind !== "tax" && item.line_total != null);
  const hasTax = record.tax != null || record.line_items.some((item) => item.kind === "tax");
  const target = record.subtotal_ex_tax?.value ?? (hasTax ? undefined : record.stated_total?.value);
  const sumWrong =
    totals.length > 0 &&
    target != null &&
    differs(
      totals.reduce((sum, item) => sum + cents(item.line_total!), 0),
      cents(target),
    );
  return lineWrong || sumWrong;
}

const comparable = (text: string) => normalizeText(text.replaceAll("*", ""));

const qtyOf = (items: LineItem[], kind: LineItem["kind"]) =>
  items.filter((item) => item.kind === kind && item.qty != null).map((item) => item.qty);

export function validateRecord(record: ServiceRecord, fileText: string): { flags: Flag[]; errors: string[] } {
  const errors: string[] = [];
  const text = comparable(fileText);
  for (const quote of quotesIn(record)) {
    if (!comparable(quote) || !text.includes(comparable(quote))) errors.push(`quote not found in file: "${quote}"`);
  }

  const numberChecks: Array<[string, number | null | undefined, string | undefined]> = [
    ["cloth_count", record.cloth_count?.value, record.cloth_count?.quote],
    ["hours_onsite", record.hours_onsite?.value, record.hours_onsite?.quote],
    ["hours_travel", record.hours_travel?.value, record.hours_travel?.quote],
    ["subtotal_ex_tax", record.subtotal_ex_tax?.value, record.subtotal_ex_tax?.quote],
    ["stated_total", record.stated_total?.value, record.stated_total?.quote],
    ["tax.rate_pct", record.tax?.rate_pct, record.tax?.quote],
    ["tax.amount", record.tax?.amount, record.tax?.quote],
    ...record.line_items.flatMap((item, i) =>
      (["qty", "rate", "line_total"] as const).map(
        (field): [string, number | null | undefined, string] => [`line_items[${i}].${field}`, item[field], item.quote],
      ),
    ),
  ];
  for (const [field, value, quote] of numberChecks) {
    if (value != null && quote != null && !numbersIn(quote).includes(value)) {
      errors.push(`${field} is ${value}, but that number is not in its quote "${quote}"`);
    }
  }
  for (const item of record.line_items) {
    if (item.part_number && !text.includes(comparable(item.part_number))) {
      errors.push(`part number "${item.part_number}" is not in the report`);
    }
  }
  const seen = new Set<string>();
  for (const item of record.line_items) {
    const key = [comparable(item.description), item.qty ?? "", item.rate ?? ""].join("|");
    if (seen.has(key)) errors.push(`"${item.description}" is listed twice with the same quantity and rate; keep one line item`);
    seen.add(key);
  }
  const totalLine = fileText
    .split("\n")
    .find((line) => /\btotal\b/i.test(line) && !/subtotal|hours|time/i.test(line) && MONEY.test(line));
  if (!record.stated_total && totalLine) errors.push(`stated_total is missing, but the report says "${totalLine.trim()}"`);

  const fileId = record.source_file.match(/FSR-\d{4}/)?.[0];
  const textId = fileText.match(/FSR-\d{4}/)?.[0];
  if (record.report_id !== fileId || record.report_id !== textId) {
    errors.push(`report ID mismatch: record ${record.report_id}, file name ${fileId}, text ${textId}`);
  }

  const travel = qtyOf(record.line_items, "travel");
  const flags: Flag[] = [];
  if (isTruncated(fileText)) flags.push("truncated");
  if (hasArithmeticMismatch(record)) flags.push("arithmetic_mismatch");
  if (record.stated_total == null && !record.line_items.some((item) => item.line_total != null)) {
    flags.push("no_cost_stated");
  }
  if (record.currency === null) flags.push("currency_unstated");
  if (qtyOf(record.line_items, "labour").some((qty) => travel.includes(qty))) flags.push("suspect_travel_hours");
  return { flags, errors };
}
