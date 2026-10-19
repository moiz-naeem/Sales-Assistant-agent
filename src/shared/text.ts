// This file tidies text so two copies of the same words can be compared.
// We only use it for matching and quote checks. The text we store keeps its original form.

export const andList = (items: string[]) =>
  items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

export function normalizeText(text: string): string {
  return text
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
