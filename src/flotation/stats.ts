// This file does the sums behind the flotation answer: where a reading sits among the hours this plant ran,
// how often the plant did worse, and which process readings rose and fell with silica.

import { quantile, QUARTILE_METHOD } from "../shared/quantile";
import { IRON, SILICA } from "./data";

export const PERCENTILE_METHOD = "mid-rank (equal values share the credit)";
export { QUARTILE_METHOD };

const finite = (values: number[]) => values.filter(Number.isFinite);

export function percentileRank(values: number[], x: number): number {
  const ok = finite(values);
  const below = ok.filter((value) => value < x).length;
  const equal = ok.filter((value) => value === x).length;
  return (100 * (below + equal / 2)) / ok.length;
}

const share = (values: number[], worse: (value: number) => boolean) => {
  const ok = finite(values);
  return ok.filter(worse).length / ok.length;
};

export const shareWorseSilica = (silica: number[], x: number) => share(silica, (value) => value >= x);
export const shareWorseIron = (iron: number[], y: number) => share(iron, (value) => value <= y);

export function shareWorseBoth(silica: number[], iron: number[], x: number, y: number): number {
  const hours = silica
    .map((value, i) => [value, iron[i]] as const)
    .filter(([s, i]) => Number.isFinite(s) && Number.isFinite(i));
  return hours.filter(([s, i]) => s >= x && i <= y).length / hours.length;
}

export function summary(values: number[]) {
  const sorted = finite(values).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    quartile_method: QUARTILE_METHOD,
  };
}

function ranks(values: number[]): number[] {
  const order = values.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let last = i;
    while (last + 1 < order.length && order[last + 1].value === order[i].value) last++;
    const rank = (i + last) / 2 + 1;
    for (let k = i; k <= last; k++) out[order[k].i] = rank;
    i = last + 1;
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let top = 0;
  let spreadA = 0;
  let spreadB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    top += da * db;
    spreadA += da * da;
    spreadB += db * db;
  }
  return top / Math.sqrt(spreadA * spreadB);
}

export function spearman(a: number[], b: number[]): { rho: number; n: number } {
  const pairs = a
    .map((value, i) => [value, b[i]] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const rho = pearson(
    ranks(pairs.map(([x]) => x)),
    ranks(pairs.map(([, y]) => y)),
  );
  return { rho, n: pairs.length };
}

export function correlates(columns: Map<string, number[]>, limit = 5) {
  const silica = columns.get(SILICA) ?? [];
  return [...columns]
    .filter(([name]) => name !== SILICA && name !== IRON)
    .map(([variable, values]) => ({ variable, ...spearman(silica, values) }))
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))
    .slice(0, limit);
}
