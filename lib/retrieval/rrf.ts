/**
 * Reciprocal Rank Fusion: each list contributes 1 / (k + rank) for every item it contains, and
 * items are ordered by the sum. Ranks are 1-based positions in each list, so only order matters,
 * which is what makes it safe to fuse scores on different scales (cosine vs ts_rank).
 *
 * Ties are broken by the best single rank an item achieved, then by its first appearance, so
 * the output is deterministic.
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  key: (item: T) => string,
  k: number,
): { item: T; score: number }[] {
  if (!(k >= 0)) throw new Error(`RRF k must be >= 0, got ${k}`);

  const fused = new Map<string, { item: T; score: number; bestRank: number; order: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      const id = key(item);
      const entry = fused.get(id);
      if (entry) {
        entry.score += 1 / (k + rank);
        entry.bestRank = Math.min(entry.bestRank, rank);
      } else {
        fused.set(id, { item, score: 1 / (k + rank), bestRank: rank, order: fused.size });
      }
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || a.order - b.order)
    .map(({ item, score }) => ({ item, score }));
}
