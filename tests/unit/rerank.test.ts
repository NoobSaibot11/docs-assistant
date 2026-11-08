import { describe, expect, it } from "vitest";

import { applyRerank } from "@/lib/retrieval/rerank";
import { makeResult } from "@/tests/helpers/chat";

describe("applyRerank", () => {
  const results = [
    makeResult({ chunkId: "a", similarity: 0.7 }),
    makeResult({ chunkId: "b", similarity: 0.6 }),
    makeResult({ chunkId: "c", similarity: 0.5 }),
  ];

  it("reorders by the reranker, re-ranks 1..n and keeps cosine similarity", () => {
    const out = applyRerank(
      results,
      [
        { index: 2, relevance: 0.91 },
        { index: 0, relevance: 0.4 },
        { index: 1, relevance: 0.1 },
      ],
      2,
    );
    expect(out.map((r) => [r.chunkId, r.rank, r.score, r.similarity])).toEqual([
      ["c", 1, 0.91, 0.5],
      ["a", 2, 0.4, 0.7],
    ]);
  });

  it("ignores indexes outside the candidate list", () => {
    expect(
      applyRerank(
        results,
        [
          { index: 7, relevance: 1 },
          { index: -1, relevance: 1 },
        ],
        5,
      ),
    ).toEqual([]);
  });
});
