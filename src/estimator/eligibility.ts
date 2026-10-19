// This file picks the past visits that match what the salesperson asked about.
// A visit counts only when it is the same machine and lists the same task. There is no "close enough".

import type { ServiceRecord } from "../services/schema";

export type Task = ServiceRecord["task_tags"][number]["tag"];

export const extraScope = (record: ServiceRecord, task: Task | undefined) =>
  [...new Set(record.task_tags.map((tag) => tag.tag))].filter((tag) => tag !== task);

export function eligibleRecords(records: ServiceRecord[], request: { equipment_model: string; task: Task }): ServiceRecord[] {
  return records.filter(
    (record) =>
      record.equipment_model.value === request.equipment_model && record.task_tags.some((tag) => tag.tag === request.task),
  );
}

export function relatedVisits(eligible: ServiceRecord[], task: Task | undefined) {
  return eligible
    .map((record) => ({
      report_id: record.report_id,
      date: record.visit_date?.as_stated,
      site: record.site?.value,
      cloth_count: record.cloth_count?.value,
      hours_onsite: record.hours_onsite?.value,
      hours_travel: record.hours_travel?.value,
      stated_total: record.stated_total?.value,
      currency: record.currency?.code,
      cost_status: record.stated_total
        ? ("stated" as const)
        : record.line_items.some((item) => item.line_total != null)
          ? ("line_items_only" as const)
          : ("none" as const),
      extra_scope: extraScope(record, task),
      flags: record.flags,
    }))
    .sort((a, b) => a.report_id.localeCompare(b.report_id));
}
