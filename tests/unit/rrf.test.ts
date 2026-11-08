import { describe, expect, it } from "vitest";

import { reciprocalRankFusion } from "@/lib/retrieval/rrf";

const id = (s: string) => s;
const fuse = (lists: string[][], k = 60) =>
  reciprocalRankFusion(lists, id, k).map(({ item, score }) => [item, Number(score.toFixed(6))]);

describe("reciprocalRankFusion", () => {
  it("sums 1 / (k + rank) across lists", () => {
    expect(
      fuse([
        ["a", "b"],
        ["b", "c"],
      ]),
    ).toEqual([
      ["b", Number((1 / 62 + 1 / 61).toFixed(6))],
      ["a", Number((1 / 61).toFixed(6))],
      ["c", Number((1 / 62).toFixed(6))],
    ]);
  });

  it("ranks an item found by both lists above one found by only one", () => {
    // "x" is 1st in one list only; "y" is 3rd and 3rd. 2/63 > 1/61.
    const fused = fuse([
      ["x", "a", "y"],
      ["b", "c", "y"],
    ]);
    expect(fused[0]?.[0]).toBe("y");
  });

  it("keeps items that appear in only one list", () => {
    expect(fuse([["a"], []]).map(([item]) => item)).toEqual(["a"]);
    expect(fuse([[], []])).toEqual([]);
  });

  it("breaks ties by best rank, then first appearance", () => {
    // a and b both score 1/61 + 1/62; c and d both 1/63.
    expect(
      fuse([
        ["a", "b", "c"],
        ["b", "a", "d"],
      ]).map(([item]) => item),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("depends only on order, never on the original scores", () => {
    const vector = [
      { id: "a", score: 0.91 },
      { id: "b", score: 0.9 },
    ];
    const keyword = [
      { id: "b", score: 12.5 },
      { id: "a", score: 0.01 },
    ];
    const fused = reciprocalRankFusion([vector, keyword], (r) => r.id, 60);
    expect(fused.map((f) => f.score)).toEqual([1 / 61 + 1 / 62, 1 / 61 + 1 / 62]);
  });

  it("lets a smaller k weight the top ranks more heavily", () => {
    // "a" is 1st in one list; "b" is 2nd in both. With k=60 agreement wins (2/62 > 1/61);
    // with k=0 a single 1st place is worth as much as two 2nd places (1 = 1/2 + 1/2), so all
    // three tie and the best single rank decides.
    const lists = [
      ["a", "b"],
      ["c", "b"],
    ];
    expect(fuse(lists, 60)[0]?.[0]).toBe("b");
    expect(fuse(lists, 0).map(([item]) => item)).toEqual(["a", "c", "b"]);
  });

  it("weights each list's contribution", () => {
    const lists = [
      ["v1", "v2", "v3"],
      ["k1", "v3", "v2"],
    ];
    // Equal weights: v3 and v2 (in both lists) beat v1 (top of one list).
    expect(
      fuse(lists)
        .map(([item]) => item)
        .slice(0, 2),
    ).toEqual(["v2", "v3"]);
    // Keyword at 0.2: agreement still helps a little, but the keyword-only k1 (1st in its list,
    // 0.2/61) falls below every vector result instead of tying with v1 (1/61).
    const weighted = reciprocalRankFusion(lists, id, 60, [1, 0.2]).map((f) => f.item);
    expect(weighted).toEqual(["v2", "v3", "v1", "k1"]);
    // Weight 0 reproduces the vector ranking exactly.
    expect(
      reciprocalRankFusion(lists, id, 60, [1, 0])
        .map((f) => f.item)
        .slice(0, 3),
    ).toEqual(lists[0]);
  });

  it("rejects missing or negative weights", () => {
    expect(() => reciprocalRankFusion([["a"], ["b"]], id, 60, [1])).toThrow(
      "one non-negative weight",
    );
    expect(() => reciprocalRankFusion([["a"]], id, 60, [-1])).toThrow("one non-negative weight");
  });

  it("rejects a negative k", () => {
    expect(() => reciprocalRankFusion([["a"]], id, -1)).toThrow("k must be");
  });
});
