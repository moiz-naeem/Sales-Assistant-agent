// This file reads the hourly flotation readings from the CSV, once, and says what is in them.

import { readFileSync } from "node:fs";

const file = new URL("../../data/flotation_process_data_hourly.csv", import.meta.url);

export const PLANT = "single iron ore flotation plant (2017)";
export const SILICA = "% Silica Concentrate";
export const IRON = "% Iron Concentrate";

export type Dataset = {
  rows: number;
  from: string;
  to: string;
  columns: Map<string, number[]>;
  missing: Record<string, number>;
};

let cached: Dataset | undefined;

export function dataset(): Dataset {
  if (cached) return cached;
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const names = header.split(",").slice(1);
  const dates: string[] = [];
  const columns = new Map(names.map((name) => [name, [] as number[]]));
  const missing = Object.fromEntries(names.map((name) => [name, 0]));

  for (const line of lines) {
    const cells = line.split(",");
    dates.push(cells[0]);
    names.forEach((name, i) => {
      const cell = cells[i + 1]?.trim();
      const value = cell ? Number(cell) : NaN;
      columns.get(name)!.push(value);
      if (!Number.isFinite(value)) missing[name]++;
    });
  }

  cached = {
    rows: lines.length,
    from: dates.reduce((first, date) => (date < first ? date : first)),
    to: dates.reduce((last, date) => (date > last ? date : last)),
    columns,
    missing,
  };
  return cached;
}

export const column = (name: string): number[] => dataset().columns.get(name) ?? [];
