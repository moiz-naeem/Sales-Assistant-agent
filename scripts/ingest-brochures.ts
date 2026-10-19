// This script builds our brochure search index. Run it with: npm run ingest:brochures
// It cuts every brochure page into pieces, turns each piece into an embedding with Gemini,
// and saves pieces and whole pages into a local LanceDB folder with a full-text index.


import { readFileSync, rmSync } from "node:fs";
import * as lancedb from "@lancedb/lancedb";
import { z } from "zod";
import { INDEX_DIR } from "../src/config";
import { ManifestEntry, manifest as realManifest } from "../src/domain/manifest";
import { embed } from "../src/llm/gemini";
import { chunkPage, parsePages } from "../src/retrieval/chunker";

const started = Date.now();


const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const src = flag("src") ?? "data/brochures";
const out = flag("out") ?? INDEX_DIR;
const manifestFile = flag("manifest");
const manifest = manifestFile
  ? z.array(ManifestEntry).parse(JSON.parse(readFileSync(manifestFile, "utf8")))
  : realManifest;

const pages = manifest.flatMap((entry) =>
  parsePages(readFileSync(`${src}/${entry.doc_id}.md`, "utf8"), entry.doc_id).map((page) => ({ entry, page })),
);
const children = pages.flatMap(({ entry, page }) => chunkPage(page, entry).map((child) => ({ entry, child })));
const vectors = await embed(
  children.map(({ child }) => child.text),
  "RETRIEVAL_DOCUMENT",
);


rmSync(out, { recursive: true, force: true });
const db = await lancedb.connect(out);

const chunks = await db.createTable(
  "chunks",
  children.map(({ entry, child }, i) => ({
    id: child.id,
    parent_id: child.parent_id,
    doc_id: child.doc_id,
    page: child.page,
    product_ids: entry.product_ids,
    product_family: entry.product_family,
    edition: entry.edition,
    text: child.text,
    raw_text: child.raw_text,
    start: child.start,
    end: child.end,
    vector: vectors[i],
  })),
);
await chunks.createIndex("text", { config: lancedb.Index.fts() });

await db.createTable(
  "pages",
  pages.map(({ page }) => ({ parent_id: `${page.doc_id}:p${page.page}`, doc_id: page.doc_id, page: page.page, text: page.text })),
);

console.log(
  `Indexed ${manifest.length} brochures, ${pages.length} pages, ${children.length} pieces ` +
    `(${vectors[0].length}-dim embeddings) into ${out} in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
);
