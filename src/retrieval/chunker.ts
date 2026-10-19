// This file cuts each brochure page into small pieces so we can search them.
// A small piece (a child) is what we match on. The whole page (the parent) is what we show and cite.

import { CHILD_MAX, CHILD_MIN, PARENT_CAP } from "../config";
import type { ManifestEntry } from "../domain/manifest";

export type Page = { doc_id: string; page: number; text: string };

export type Child = {
  id: string;
  parent_id: string;
  doc_id: string;
  page: number;
  text: string;
  raw_text: string;
  start: number;
  end: number;
};

type Line = { start: number; end: number };

export function parsePages(md: string, docId: string): Page[] {
  const parts = md.split(/^## Page (\d+)$/m);
  const pages: Page[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    pages.push({ doc_id: docId, page: Number(parts[i]), text: parts[i + 1].trim() });
  }
  return pages;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const raw of text.split("\n")) {
    let from = start;
    const to = start + raw.length;
    while (to - from > CHILD_MAX) {
      const space = text.lastIndexOf(" ", from + CHILD_MAX);
      const end = space > from ? space : from + CHILD_MAX;
      lines.push({ start: from, end });
      from = space > from ? space + 1 : end;
    }
    if (text.slice(from, to).trim()) lines.push({ start: from, end: to });
    start = to + 1;
  }
  return lines;
}

export function chunkPage(page: Page, entry: ManifestEntry): Child[] {
  const groups: Line[][] = [];
  let current: Line[] = [];
  let hasNewLine = false;
  const last = () => current[current.length - 1];

  for (const line of linesOf(page.text)) {
    if (current.length && line.end - current[0].start > CHILD_MAX) {
      if (hasNewLine) groups.push(current);
      current = hasNewLine && line.end - last().start <= CHILD_MAX ? [last()] : [];
      hasNewLine = false;
    }
    current.push(line);
    hasNewLine = true;
    if (last().end - current[0].start >= CHILD_MIN) {
      groups.push(current);
      current = [last()];
      hasNewLine = false;
    }
  }
  if (hasNewLine) groups.push(current);

  const parent_id = `${page.doc_id}:p${page.page}`;
  return groups.map((group, k) => {
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const raw_text = page.text.slice(start, end);
    return {
      id: `${parent_id}:c${k}`,
      parent_id,
      doc_id: page.doc_id,
      page: page.page,
      text: `${entry.title} | page ${page.page}\n${raw_text}`,
      raw_text,
      start,
      end,
    };
  });
}

export function parentText(pageText: string, child: { start: number; end: number }) {
  if (pageText.length <= PARENT_CAP) return { text: pageText, truncated: false };
  const middle = Math.floor((child.start + child.end) / 2);
  let from = Math.max(0, Math.min(middle - PARENT_CAP / 2, pageText.length - PARENT_CAP));
  let to = from + PARENT_CAP;
  if (from > 0) from = pageText.indexOf("\n", from) + 1;
  if (to < pageText.length) to = pageText.lastIndexOf("\n", to);
  return { text: pageText.slice(from, to), truncated: true };
}
