// This file loads our hand-written list of brochures and checks it is well formed.
// It tells the rest of the app which products each brochure covers and which family they belong to.

import { readFileSync } from "node:fs";
import { z } from "zod";

export const ProductFamily = z.enum(["pressure_filter", "solution_filter", "flotation", "pump", "control_system"]);

export const ManifestEntry = z.object({
  doc_id: z.string(),
  title: z.string(),
  source_pdf: z.string(),
  product_ids: z.array(z.string()).min(1),
  product_names: z.array(z.string()).min(1),
  product_family: ProductFamily,
  applies_to: z
    .array(z.object({ family: ProductFamily, quote: z.string(), page: z.number().int().positive() }))
    .optional(),
  edition: z.string(),
  page_count: z.number().int().positive(),
});

export type ManifestEntry = z.infer<typeof ManifestEntry>;

const file = new URL("../../knowledge/brochures.manifest.json", import.meta.url);
export const manifest = z.array(ManifestEntry).parse(JSON.parse(readFileSync(file, "utf8")));

export const byDocId = (docId: string) => manifest.find((entry) => entry.doc_id === docId);
export const docsForProduct = (productId: string) => manifest.filter((entry) => entry.product_ids.includes(productId));
export const docsForFamily = (family: z.infer<typeof ProductFamily>) =>
  manifest.filter((entry) => entry.product_family === family);
