// This file merges several ranked lists into one, using Reciprocal Rank Fusion (RRF).

import { RRF_K } from "../config";

export function rrf(rankings: string[][], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
