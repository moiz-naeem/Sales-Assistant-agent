// This file is the last gate before the salesperson sees anything.
// It checks that every id, number and quote in the answer really came from a tool or from the customer.

import { byDocId } from "../domain/manifest";
import { numbersIn } from "../shared/numbers";
import { normalizeText } from "../shared/text";
import type { SubmitAnswer } from "./answer";
import type { AnswerContext } from "./loop";

const cents = (value: number) => Math.round(value * 100);
const forMatching = (text: string) => normalizeText(text).toLowerCase();

function numbersInside(value: unknown, into: Set<number>) {
  if (typeof value === "number") into.add(cents(value));
  else if (typeof value === "string") for (const found of numbersIn(value)) into.add(cents(found));
  else if (Array.isArray(value)) for (const item of value) numbersInside(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) numbersInside(item, into);
}

export function validateAnswer(answer: SubmitAnswer, context: AnswerContext): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const cited = new Set([
    ...answer.claims.flatMap((claim) => claim.evidence_ids),
    ...(answer.recommendation?.evidence_ids ?? []),
  ]);

  for (const id of cited) {
    if (!context.evidence.has(id)) errors.push(`No tool returned the id ${id} this turn, so it cannot be cited.`);
  }
  if (answer.estimate_ref && !context.evidence.has(answer.estimate_ref)) {
    errors.push(`No estimate called ${answer.estimate_ref} was made this turn.`);
  }

  for (const claim of answer.claims) {
    if (!claim.evidence_ids.length) errors.push(`The claim "${claim.text}" has no evidence id.`);
  }
  if (!answer.claims.length && numbersIn(answer.answer).length) {
    errors.push("The answer gives a number but makes no claim, so nothing backs it up.");
  }

  const allowed = new Set<number>();
  for (const message of context.user_messages) numbersInside(message, allowed);
  for (const id of cited) numbersInside(id, allowed);
  for (const page of context.pages.filter((page) => cited.has(page.evidence_id))) {
    numbersInside(page.text, allowed);
    allowed.add(cents(page.page));
  }
  const estimate = context.estimates.find((item) => item.estimate_id === answer.estimate_ref);
  if (estimate) numbersInside(estimate.result, allowed);
  for (const assessment of context.assessments) numbersInside(assessment, allowed);

  const written = [
    answer.answer,
    ...answer.claims.map((claim) => claim.text),
    answer.recommendation?.reasoning_link.link_statement,
    answer.next_question,
  ];
  for (const text of written) {
    for (const found of numbersIn(text ?? "")) {
      if (!allowed.has(cents(found))) {
        errors.push(`The number ${found} is not in anything a tool returned or the customer said.`);
      }
    }
  }

  const link = answer.recommendation?.reasoning_link;
  if (link) {
    const need = forMatching(link.customer_need_quote);
    if (!need || !context.user_messages.some((message) => forMatching(message).includes(need))) {
      errors.push("The customer need quote is not in anything the customer wrote.");
    }
    const pages = context.pages.filter((page) => answer.recommendation!.evidence_ids.includes(page.evidence_id));
    const said = forMatching(link.brochure_quote);
    if (!said || !pages.some((page) => forMatching(page.text).includes(said))) {
      errors.push("The brochure quote is not in any page the recommendation cites.");
    }
    const products = new Set(pages.flatMap((page) => byDocId(page.doc_id)?.product_ids ?? []));
    if (!products.has(answer.recommendation!.product_id)) {
      errors.push(`The cited pages are not about ${answer.recommendation!.product_id}, so it cannot be recommended from them.`);
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
