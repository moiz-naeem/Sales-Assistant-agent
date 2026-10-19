// This file describes one cleaned-up service report.
// Every value we take from a report keeps the exact words it came from, so anyone can check it against the file.

import { z } from "zod";
import { EquipmentOrOther, TaskTag } from "../domain/vocab";

const quoted = <T extends z.ZodType>(value: T) => z.object({ value, quote: z.string() });

const Coverage = z.enum(["included", "excluded", "unknown"]);

export const Flag = z.enum([
  "truncated",
  "arithmetic_mismatch",
  "no_cost_stated",
  "currency_unstated",
  "suspect_travel_hours",
]);

export const Currency = z.object({
  code: z.string(),
  source: z.enum(["iso_code", "header", "sign_usd", "sign_eur"]),
  quote: z.string(),
});

export const LineItem = z.object({
  kind: z.enum(["labour", "travel", "filter_cloth", "other_part", "consumable", "tax", "other"]),
  description: z.string(),
  part_number: z.string().nullish(),
  qty: z.number().nullish(),
  unit: z.string().nullish(),
  rate: z.number().nullish(),
  line_total: z.number().nullish(),
  quote: z.string(),
});

export const ServiceRecord = z.object({
  report_id: z.string(),
  source_file: z.string(),
  customer: quoted(z.string()).nullish(),
  site: quoted(z.string()).nullish(),
  country: quoted(z.string()).nullish(),
  visit_date: z
    .object({ as_stated: z.string(), iso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), quote: z.string() })
    .nullish(),
  technician: quoted(z.string()).nullish(),
  equipment_model: quoted(EquipmentOrOther),
  task_tags: z.array(z.object({ tag: TaskTag, quote: z.string() })),
  cloth_count: quoted(z.number().int()).nullish(),
  hours_onsite: quoted(z.number()).nullish(),
  hours_travel: quoted(z.number()).nullish(),
  line_items: z.array(LineItem),
  subtotal_ex_tax: quoted(z.number()).nullish(),
  tax: z.object({ rate_pct: z.number().nullish(), amount: z.number().nullish(), quote: z.string() }).nullish(),
  stated_total: quoted(z.number()).nullish(),
  currency: Currency.nullable(),
  cost_coverage: z.object({ labour: Coverage, travel: Coverage, parts: Coverage, tax: Coverage }),
  flags: z.array(Flag),
});

export type Flag = z.infer<typeof Flag>;
export type Currency = z.infer<typeof Currency>;
export type LineItem = z.infer<typeof LineItem>;
export type ServiceRecord = z.infer<typeof ServiceRecord>;
