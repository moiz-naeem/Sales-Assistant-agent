// This file finds a quantile in a sorted list of numbers, the way Excel's QUARTILE.INC does.

export const QUARTILE_METHOD = "inclusive linear interpolation (Excel QUARTILE.INC)";

export function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (at - low) * (sorted[high] - sorted[low]);
}
