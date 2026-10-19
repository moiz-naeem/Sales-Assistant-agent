// This file lays the checked answer out as plain text for the salesperson to read on a call.


import type { ServiceEstimateResult } from "../estimator/estimate";
import type { ProductEvidence } from "../retrieval/search";
import { andList } from "../shared/text";
import type { SubmitAnswer } from "./answer";
import type { AnswerContext } from "./loop";

const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function coverageWords(coverage: Record<string, string>): string {
  const of = (state: string) => Object.keys(coverage).filter((part) => coverage[part] === state);
  const said = [];
  if (of("included").length) said.push(`${andList(of("included"))} included`);
  if (of("excluded").length) said.push(`${andList(of("excluded"))} excluded`);
  if (of("unknown").length) said.push(`${andList(of("unknown"))} not stated`);
  return said.join(", ");
}

const pageOf = (id: string, pages: ProductEvidence[]) => pages.find((page) => page.evidence_id === id);

function renderEstimate(result: ServiceEstimateResult): string {
  const lines = ["Estimate (from past service reports, nothing converted between currencies)"];

  for (const group of result.currency_groups) {
    lines.push(`  ${group.currency} — ${group.status}`);
    for (const part of group.parts) {
      const name = part.part_number ?? "part number not stated";
      const price = part.computation
        ? `${part.computation.formula} = ${money(part.computation.result)}`
        : `${money(part.unit_prices[0]?.rate ?? 0)} each`;
      lines.push(`    Cloth price, ${name}: ${price} (${andList(part.unit_prices.map((p) => p.report_id))})`);
    }
    for (const visit of group.visit_totals) {
      const when = visit.date ? `, ${visit.date}` : "";
      lines.push(
        `    Visit total ${visit.report_id}${when}: ${money(visit.stated_total)} (${coverageWords(visit.coverage)})`,
      );
    }
    for (const sum of group.line_sums) {
      const when = sum.date ? `, ${sum.date}` : "";
      lines.push(
        `    Lines in ${sum.report_id}${when} — ${sum.truncated ? "the report is cut off before its total" : "the report states no total"}`,
      );
      for (const line of sum.lines) {
        lines.push(`      ${line.description}: ${line.formula ? `${line.formula} = ` : ""}${money(line.amount)}`);
      }
      lines.push(`      These lines add up to ${money(sum.total)} (${coverageWords(sum.coverage)})`);
    }
    if (!group.parts.length && !group.visit_totals.length && !group.line_sums.length) lines.push("    No priced lines.");
  }


  return lines.join("\n");
}


function renderReport(report: NonNullable<ServiceEstimateResult["report"]>): string {
  const where = [report.date, report.site].filter(Boolean).join(", ");
  const lines = [
    "Estimate (from one past service report)",
    `  ${report.report_id}${where ? `, ${where}` : ""}${report.currency ? ` — ${report.currency}` : ""}`,
  ];
  for (const line of report.lines) {
    lines.push(`    ${line.description}: ${line.formula ? `${line.formula} = ` : ""}${money(line.amount)}`);
  }
  if (report.stated_total == null) {
    lines.push(`    These lines add up to ${money(report.lines_total)} (${coverageWords(report.coverage)})`);
  } else {
    lines.push(`    Visit total: ${money(report.stated_total)} (${coverageWords(report.coverage)})`);

    if (Math.round(report.stated_total * 100) !== Math.round(report.lines_total * 100)) {
      lines.push(`    The lines above add up to ${money(report.lines_total)}`);
    }
  }
  return lines.join("\n");
}

function renderSources(cited: string[], context: AnswerContext): string {
  const visits = context.estimates.flatMap((item) => {
    const result = item.result as ServiceEstimateResult;
    return [...result.related_visits, ...(result.report ? [result.report] : [])];
  });
  const lines: string[] = [];

  for (const id of cited) {
    const page = pageOf(id, context.pages);
    if (page) {
      lines.push(
        `  ${id} — ${page.title ?? page.doc_id}, page ${page.page}${page.source_pdf ? ` (${page.source_pdf})` : ""}`,
      );
      continue;
    }
    const visit = visits.find((item) => item.report_id === id);
    if (visit) {
      lines.push(`  ${id} — ${[visit.date, visit.site].filter(Boolean).join(", ") || "service report"}`);
      continue;
    }
    const estimate = context.estimates.find((item) => item.estimate_id === id);
    if (estimate) {
      const result = estimate.result as ServiceEstimateResult;
      const from = result.report
        ? `report ${result.report.report_id}`
        : `${result.related_visits.length} past service reports`;
      lines.push(`  ${id} — worked out from ${from}, shown above`);
      continue;
    }
    const assessment = context.assessments.find((item) => item.assessment_id === id);
    if (assessment) {
      const { rows, from, to } = assessment.dataset;
      lines.push(`  ${id} — ${rows} logged hours at one iron ore plant, ${from.slice(0, 10)} to ${to.slice(0, 10)}`);
      continue;
    }
    lines.push(`  ${id}`);
  }
  return lines.length ? `Sources:\n${lines.join("\n")}` : "";
}

export function render(answer: SubmitAnswer, context: AnswerContext): string {
  const sections = [answer.answer.trim()];

  const estimate = context.estimates.find((item) => item.estimate_id === answer.estimate_ref);
  if (estimate) {
    const result = estimate.result as ServiceEstimateResult;
    sections.push(result.report ? renderReport(result.report) : renderEstimate(result));
  }

  const cited = [
    ...new Set([...answer.claims.flatMap((c) => c.evidence_ids), ...(answer.recommendation?.evidence_ids ?? [])]),
  ];
  const sources = renderSources(cited, context);
  if (sources) sections.push(sources);

  if (answer.next_question) sections.push(`Next question: ${answer.next_question}`);
  return sections.join("\n\n");
}
