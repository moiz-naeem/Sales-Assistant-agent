// This file finds the brochure pages that best answer a question.
// It runs a meaning search and a word search over the small pieces, merges the two with RRF,
// and hands back whole pages with everything we need to cite them.

import * as lancedb from "@lancedb/lancedb";
import { CANDIDATES_PER_RETRIEVER, INDEX_DIR, TOP_K } from "../config";
import { byDocId, manifest } from "../domain/manifest";
import { embed } from "../llm/gemini";
import { parentText } from "./chunker";
import { rrf } from "./rrf";

export type ProductEvidence = {
  evidence_id: string;
  doc_id: string;
  title: string;
  page: number;
  edition: string;
  source_pdf: string;
  text: string;
  truncated: boolean;
  matched_child_ids: string[];
  score: number;
};

export type SearchFilters = { product_family?: string; doc_id?: string; product_id?: string };

type ChunkRow = { id: string; parent_id: string; doc_id: string; page: number; start: number; end: number };

const indexes = new Map<string, Promise<{ chunks: lancedb.Table; pages: Map<string, string> }>>();

function openIndex(dir: string) {
  if (!indexes.has(dir)) {
    indexes.set(
      dir,
      (async () => {
        const db = await lancedb.connect(dir);
        const pages = await (await db.openTable("pages")).query().toArray();
        return { chunks: await db.openTable("chunks"), pages: new Map(pages.map((row) => [row.parent_id, row.text])) };
      })(),
    );
  }
  return indexes.get(dir)!;
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function orLinked(clause: string, family: string | undefined): string {
  const linked = manifest.filter((entry) => entry.applies_to?.some((link) => link.family === family));
  return linked.length ? `(${clause} OR doc_id IN (${linked.map((entry) => quote(entry.doc_id)).join(", ")}))` : clause;
}

const familyOf = (productId: string) =>
  manifest.find((entry) => entry.product_ids?.includes(productId))?.product_family;

function whereOf({ product_family, doc_id, product_id }: SearchFilters): string {
  const parts: string[] = [];
  if (product_family) parts.push(orLinked(`product_family = ${quote(product_family)}`, product_family));
  if (doc_id) parts.push(`doc_id = ${quote(doc_id)}`);
  if (product_id) parts.push(orLinked(`array_has(product_ids, ${quote(product_id)})`, familyOf(product_id)));
  return parts.join(" AND ");
}

export async function search(
  query: string,
  { topK = TOP_K, indexDir = INDEX_DIR, ...filters }: SearchFilters & { topK?: number; indexDir?: string } = {},
): Promise<ProductEvidence[]> {
  const [{ chunks, pages }, [vector]] = await Promise.all([openIndex(indexDir), embed([query], "RETRIEVAL_QUERY")]);
  const where = whereOf(filters);
  const columns = ["id", "parent_id", "doc_id", "page", "start", "end"];
  const retrievers = [
    { search: chunks.vectorSearch(vector).distanceType("cosine"), select: [...columns, "_distance"] },
    { search: chunks.query().fullTextSearch(query), select: [...columns, "_score"] },
  ];
  const [byMeaning, byWords]: ChunkRow[][] = await Promise.all(
    retrievers.map(({ search: q, select }) =>
      (where ? q.where(where) : q).select(select).limit(CANDIDATES_PER_RETRIEVER).toArray(),
    ),
  );

  const rows = new Map([...byMeaning, ...byWords].map((row) => [row.id, row]));
  const parents = new Map<string, { best: ChunkRow; score: number; ids: string[] }>();
  for (const { id, score } of rrf([byMeaning.map((row) => row.id), byWords.map((row) => row.id)])) {
    const row = rows.get(id)!;
    const parent = parents.get(row.parent_id);
    if (parent) parent.ids.push(id);
    else parents.set(row.parent_id, { best: row, score, ids: [id] });
  }

  return [...parents.values()].slice(0, topK).map(({ best, score, ids }) => {
    const entry = byDocId(best.doc_id);
    return {
      evidence_id: best.parent_id,
      doc_id: best.doc_id,
      title: entry?.title ?? best.doc_id,
      page: best.page,
      edition: entry?.edition ?? "unknown",
      source_pdf: entry?.source_pdf ?? "",
      ...parentText(pages.get(best.parent_id)!, best),
      matched_child_ids: ids,
      score,
    };
  });
}
