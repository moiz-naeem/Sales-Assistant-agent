// This file reads the cleaned-up service reports from disk, once, and hands the same list to everyone who asks.

import { readFileSync } from "node:fs";
import { ServiceRecord } from "./schema";

const file = new URL("../../knowledge/service_records.json", import.meta.url);
let cached: ServiceRecord[] | undefined;

export const serviceRecords = (): ServiceRecord[] =>
  (cached ??= ServiceRecord.array().parse(JSON.parse(readFileSync(file, "utf8"))));
