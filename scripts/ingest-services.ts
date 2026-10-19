// This script turns the 50 messy service reports into clean, checked records. Run it with: npm run ingest:services
// Gemini reads each report and fills in our schema, quoting the report for every value.
// Then our own code adds the currency, the cost coverage and the flags, and checks every quote and number against the file.
// Use "--only FSR-0027" to redo a single report. A report that fails keeps its last good record.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "../src/config";
import { manifest } from "../src/domain/manifest";
import { generateStructured } from "../src/llm/gemini";
import { resolveCurrency } from "../src/services/currency";
import { type LineItem, ServiceRecord } from "../src/services/schema";
import { validateRecord } from "../src/services/validate";

const REPORTS_DIR = "data/HistoricalServices";
const RECORDS_FILE = "knowledge/service_records.json";
const LOG_FILE = "knowledge/service_extraction_log.jsonl";
const MAX_PASSES = 3;

const Extracted = ServiceRecord.omit({ source_file: true, currency: true, flags: true });
const COVERS: Partial<Record<LineItem["kind"], keyof ServiceRecord["cost_coverage"]>> = {
  labour: "labour",
  travel: "travel",
  filter_cloth: "parts",
  other_part: "parts",
  tax: "tax",
};

const products = [...new Map(manifest.flatMap((entry) => entry.product_ids.map((id) => [id, entry.product_names.join(", ")])))]
  .map(([id, names]) => `  ${id}: ${names}`)
  .join("\n");

const SYSTEM = `You copy facts out of one field service report into JSON. You are a careful clerk, not an analyst.

Rules:
- Take only what is written. Never compute, convert, add up, multiply, round or guess a value.
  "4.5h travel each way" does not give hours_travel 9: no total is written, so leave hours_travel out.
- If a value is not written, leave the field out. Never fill a field from general knowledge.
- Every number you give must appear, written the same way, inside that field's quote.
- Every "quote" is copied from the report exactly, character for character, including markdown such as ** and |,
  and including the spaces inside table rows. Never add, drop or reword anything in a quote, such as a "- " bullet.
  A single table cell may be quoted on its own.
- A report can be cut off in the middle of a row. Quote such a row exactly where it stops, and never finish it:
  "| Clips | 24 | €2.60/ea | €" has no line total, even if another table shows one.
- Amounts are plain numbers with no currency sign and no thousands separator: "$1,639.00" becomes 1639.
- report_id is the FSR number written in the report.
- visit_date.as_stated is the date exactly as written. Set visit_date.iso only when the report already writes the date as YYYY-MM-DD.
- equipment_model.value is one of these product IDs, or "other:<model code as written>" when none fits.
  For "other", use only the model code or shortest model name, not the full description: "SALA VSP-750 Vertical Sump Pump" becomes "other:VSP-750".
${products}
- task_tags: every tag that fits a task the report says was done on this visit, each tag once, with a quote that shows the task.
  Tag only work that was done. A problem that was only found, flagged or left for later is not a task:
  "small leak at the hydraulic pump, flagged to site, no parts to fix" gives no hydraulic_service.
  Pick the tag by what the work did, not by a word in it: "reset two alarms and cleared the log" is not control_system_upgrade,
  and "tightened all bolts" is not inspection.
  Use only these tags:
  filter_cloth_replacement: filter cloths replaced. hydraulic_service: any work on the hydraulic system (oil, valve, HYD unit).
  emergency_repair: the report calls the visit an emergency, breakdown or call-out. inspection: something was inspected or checked.
  calibration: sensors or instruments calibrated. commissioning: new equipment started up for the first time.
  control_system_upgrade: control software or settings updated or installed. pump_overhaul: a pump opened and wear parts
  (impeller, seal, bearings) replaced. cleaning: something cleaned. preventive_maintenance: scheduled or routine maintenance.
- cloth_count only when the number of filter cloths replaced is written as a number.
  The quantity of a filter cloth row in a cost table counts: "| Filter Cloth | piece | 18 | 46 | 828.00 |" gives cloth_count 18
  with that row as the quote. "All 18 cloths were worn" alone is not a replacement count.
- hours_onsite and hours_travel only when the hours are written. A travel or labour row of a cost table counts:
  "| Travel (to site) | hours | 3.5 | 60 | 210.00 |" gives hours_travel 3.5 with that row as the quote,
  even when the report also has a separate time table.
- line_items: one item per priced cost line in a cost table or cost sentence. The quote is the whole table row or the whole sentence.
  A list of parts used with no prices ("2 x MD650 impellers") is not a line item.
  A report can hold more than one table with prices, such as a materials table and a cost summary.
  Take every priced line from all of them. A line that stands in both tables, with the same item, quantity and price,
  is one line item, not two. A line that stands in only one of them is still a line item, as in Example 1.
  part_number: copy the item's part number when the report states it anywhere. A separate parts or materials table counts,
  even when it names the item differently: match it by the same quantity and price, as in Example 1.
  kind is labour, travel, filter_cloth (filter cloths), other_part (spare parts), consumable (oil, cleaning supplies and other used-up material), tax (VAT, GST or other tax lines) or other.
  Never make a line item from a subtotal or total row.
- subtotal_ex_tax only when a subtotal before tax is written. tax only when a tax is written. stated_total is the final total as written.
- cost_coverage says what the written cost covers, for labour, travel, parts and tax:
  "included" when the cost lists it or says it includes it, as in "Total (labour, travel, parts): $1,000";
  tax is "included" when the total adds a written VAT, GST or tax amount, as in "Subtotal 100 / VAT (24%) 24 / Total 124";
  "excluded" only when the report says the cost leaves it out, as in "Total (ex. VAT)";
  otherwise "unknown". When the report writes no amount at all ("as per agreement + travel", "invoice to follow"), all four are "unknown".

Before you answer, check the report once more:
- every row of every cost table (except subtotal and total rows) is a line item, with its qty, rate and line total;
- a priced row that only one of the tables holds is there too, and a row both tables hold is there once;
- every part number in a parts table is on its line item;
- the final total, the travel hours and the on-site hours are filled in when the report writes them;
- nothing in your answer is missing from the report, and nothing written in the report's cost lines is missing from your answer.

Example 1, a table report:
---
Report Reference: FSR-9001
**Customer:** Example Mining
**Visit Date:** 2024-03-04
**Equipment Serviced:** Larox PF-DS Tower Press Filter
- Replaced 10 filter cloths.
### Parts Used
| Item | Part Number | Qty | Unit Cost (EUR) | Total (EUR) |
|---|---|---|---|---|
| Cloth, PF-DS tower | PFDS-FC-900 | 10 | 98.00 | 980.00 |
| Cleaning supplies | N/A | 1 lot | 18.00 | 18.00 |
### Cost Summary
| Description | Quantity | Rate (EUR) | Total (EUR) |
|---|---|---|---|
| Travel | 3.0 hrs | €60.00/hr | €180.00 |
| Labour | 5.5 hrs | €80.00/hr | €440.00 |
| Filter Cloth PF-DS | 10 | €98.00/ea | €980.00 |
| **Total** | | | **€1,618.00** |
---
${JSON.stringify({
  report_id: "FSR-9001",
  customer: { value: "Example Mining", quote: "**Customer:** Example Mining" },
  visit_date: { as_stated: "2024-03-04", iso: "2024-03-04", quote: "**Visit Date:** 2024-03-04" },
  equipment_model: { value: "larox_pf_ds", quote: "Larox PF-DS Tower Press Filter" },
  task_tags: [{ tag: "filter_cloth_replacement", quote: "Replaced 10 filter cloths." }],
  cloth_count: { value: 10, quote: "Replaced 10 filter cloths." },
  hours_onsite: { value: 5.5, quote: "| Labour | 5.5 hrs | €80.00/hr | €440.00 |" },
  hours_travel: { value: 3, quote: "| Travel | 3.0 hrs | €60.00/hr | €180.00 |" },
  line_items: [
    { kind: "travel", description: "Travel", qty: 3, unit: "hrs", rate: 60, line_total: 180, quote: "| Travel | 3.0 hrs | €60.00/hr | €180.00 |" },
    { kind: "labour", description: "Labour", qty: 5.5, unit: "hrs", rate: 80, line_total: 440, quote: "| Labour | 5.5 hrs | €80.00/hr | €440.00 |" },
    { kind: "filter_cloth", description: "Filter Cloth PF-DS", part_number: "PFDS-FC-900", qty: 10, unit: "ea", rate: 98, line_total: 980, quote: "| Filter Cloth PF-DS | 10 | €98.00/ea | €980.00 |" },
    { kind: "consumable", description: "Cleaning supplies", qty: 1, unit: "lot", rate: 18, line_total: 18, quote: "| Cleaning supplies | N/A | 1 lot | 18.00 | 18.00 |" },
  ],
  stated_total: { value: 1618, quote: "| **Total** | | | **€1,618.00** |" },
  cost_coverage: { labour: "included", travel: "included", parts: "included", tax: "unknown" },
})}

Example 2, a field note:
---
FSR-9002
Customer: Example Copper
Date: 12/6/2023
Serviced the MD pump, replaced impeller. On site about 6 hours, travel 2 hours. Invoice to follow.
---
${JSON.stringify({
  report_id: "FSR-9002",
  customer: { value: "Example Copper", quote: "Customer: Example Copper" },
  visit_date: { as_stated: "12/6/2023", quote: "Date: 12/6/2023" },
  equipment_model: { value: "md_series_pump", quote: "MD pump" },
  task_tags: [{ tag: "pump_overhaul", quote: "replaced impeller" }],
  hours_onsite: { value: 6, quote: "On site about 6 hours" },
  hours_travel: { value: 2, quote: "travel 2 hours" },
  line_items: [],
  cost_coverage: { labour: "unknown", travel: "unknown", parts: "unknown", tax: "unknown" },
})}`;

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
const files = readdirSync(REPORTS_DIR)
  .filter((file) => file.endsWith(".txt") && (!only || file === `${only}.txt`))
  .sort();
if (!files.length) throw new Error(`No report file found${only ? ` for ${only}` : ""}.`);

const idOf = (file: string) => file.match(/FSR-\d{4}/)![0];
const records = new Map<string, ServiceRecord>(
  existsSync(RECORDS_FILE)
    ? JSON.parse(readFileSync(RECORDS_FILE, "utf8")).map((r: ServiceRecord) => [idOf(r.source_file), r])
    : [],
);
const logs = new Map<string, object>(
  existsSync(LOG_FILE)
    ? readFileSync(LOG_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((entry) => [entry.report_id, entry])
    : [],
);

let problems = 0;
for (const file of files) {
  const id = idOf(file);
  const text = readFileSync(`${REPORTS_DIR}/${file}`, "utf8");
  const source = `Report file: ${file}\n\n${text}`;
  const usage = { input_tokens: 0, output_tokens: 0, schema_retries: 0, check_retries: 0 };
  try {
    let prompt = source;
    let record: ServiceRecord;
    let result: ReturnType<typeof validateRecord>;
    for (let pass = 1; ; pass++) {
      const answer = await generateStructured({ system: SYSTEM, prompt, schema: Extracted });
      usage.input_tokens += answer.usage.inputTokens;
      usage.output_tokens += answer.usage.outputTokens;
      usage.schema_retries += answer.attempts - 1;
      record = { ...answer.data, source_file: `${REPORTS_DIR}/${file}`, currency: resolveCurrency(text), flags: [] };
      for (const item of record.line_items) {
        const field = COVERS[item.kind];
        if (field) record.cost_coverage[field] = "included";
      }
      result = validateRecord(record, text);
      if (!result.errors.length || pass === MAX_PASSES) break;
      usage.check_retries++;
      prompt = `${source}\n\nYour last answer broke these rules. Read the report again and fix them. Never compute a value; leave a field out instead:\n- ${result.errors.join("\n- ")}`;
    }
    record.flags = result.flags;

    if (!result.errors.length) records.set(id, record);
    else problems++;
    logs.set(id, {
      report_id: id,
      model: env.GEMINI_MODEL,
      ...usage,
      currency_source: record.currency?.source ?? null,
      flags: result.flags,
      errors: result.errors,
    });
    console.log(`${id}  ${record.equipment_model.value}  flags: ${result.flags.join(", ") || "none"}  errors: ${result.errors.length}`);
  } catch (error) {
    problems++;
    const message = error instanceof Error ? error.message : String(error);
    logs.set(id, { report_id: id, model: env.GEMINI_MODEL, ...usage, failed: message });
    console.log(`${id}  FAILED: ${message}`);
  }
}

const sorted = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
writeFileSync(RECORDS_FILE, `${JSON.stringify(sorted(records), null, 2)}\n`);
writeFileSync(LOG_FILE, `${sorted(logs).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
console.log(`\nWrote ${records.size} records to ${RECORDS_FILE}. ${problems} report(s) need attention (see ${LOG_FILE}).`);
if (problems) process.exitCode = 1;
