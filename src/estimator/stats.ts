// This file does the small statistics the estimator shows: median, min, max and, with enough visits, quartiles.

import { quantile as exact, QUARTILE_METHOD } from "../shared/quantile";

export { QUARTILE_METHOD };

export type Tier = "unavailable" | "limited" | "sufficient";

export const tier = (n: number): Tier => (n === 0 ? "unavailable" : n === 1 ? "limited" : "sufficient");

const quantile = (sorted: number[], q: number) => Math.round(exact(sorted, q));

export function stats(valuesCents: number[]) {
  const sorted = [...valuesCents].sort((a, b) => a - b);
  const base = { n: sorted.length, median: quantile(sorted, 0.5), min: sorted[0], max: sorted[sorted.length - 1] };
  if (sorted.length < 4) return base;
  return { ...base, q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75), quartile_method: QUARTILE_METHOD };
}
