// tests/unit/eval-metrics.test.js — pure IR metric functions for the eval harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recallAtK, successAtK, reciprocalRank, ndcgAtK,
  scoreQuery, meanOf, aggregate,
} from "../../eval/metrics.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("recallAtK: fraction of relevant in top-k", () => {
  const r = ["a", "b", "c", "d"];
  close(recallAtK(r, ["a", "c"], 1), 0.5); // {a} of {a,c}
  close(recallAtK(r, ["a", "c"], 2), 0.5); // top2=[a,b] -> {a}
  close(recallAtK(r, ["a", "c"], 4), 1.0); // both found
  assert.equal(recallAtK(r, [], 5), null); // no labels -> null
});

test("successAtK: 1 if any relevant in top-k", () => {
  const r = ["a", "b", "c"];
  assert.equal(successAtK(r, ["c"], 2), 0); // top2=[a,b]
  assert.equal(successAtK(r, ["c"], 3), 1);
  assert.equal(successAtK(r, ["a"], 1), 1);
  assert.equal(successAtK(r, [], 3), null);
});

test("reciprocalRank: 1/rank of first hit", () => {
  close(reciprocalRank(["a", "b", "c"], ["c"]), 1 / 3);
  close(reciprocalRank(["a", "b", "c"], ["a"]), 1);
  assert.equal(reciprocalRank(["a", "b"], ["x"]), 0); // present in labels, not retrieved
  assert.equal(reciprocalRank(["a"], []), null);
});

test("ndcgAtK: graded DCG / ideal-DCG", () => {
  close(ndcgAtK(["a", "b"], ["a"], 10), 1.0);                 // perfect: hit at rank 1
  close(ndcgAtK(["b", "a"], ["a"], 10), 1 / Math.log2(3), 1e-12); // hit at rank 2, idcg=1
  close(ndcgAtK(["a", "b"], ["a", "b"], 10), 1.0);            // both, in ideal order
  assert.equal(ndcgAtK(["a"], [], 10), null);
  // alternate (gain 0.5) only: dcg=0.5; idcg from gains [1.0(rel),0.5(alt)]
  const idcg = 1 / Math.log2(2) + 0.5 / Math.log2(3);
  close(ndcgAtK(["alt1"], ["r1"], 10, ["alt1"]), 0.5 / idcg, 1e-12);
});

test("scoreQuery: flat metric map with null where undefined", () => {
  const out = scoreQuery(["a", "b", "c"], { qid: "q1", relevant_ids: ["c"] }, [1, 3]);
  assert.equal(out.qid, "q1");
  assert.equal(out["recall@1"], 0);
  close(out["recall@3"], 1);
  assert.equal(out["success@1"], 0);
  assert.equal(out["success@3"], 1);
  close(out.mrr, 1 / 3);
});

test("meanOf: skips null, null if all null", () => {
  close(meanOf([1, null, 0]), 0.5);
  assert.equal(meanOf([null, null]), null);
  assert.equal(meanOf([]), null);
});

test("aggregate: overall means + breakdown by dimension", () => {
  const queries = [
    { qid: "q1", lang: "ko", relevant_ids: ["a"] },
    { qid: "q2", lang: "en", relevant_ids: ["z"] },
  ];
  const per = [
    scoreQuery(["a", "b"], queries[0], [5]), // recall@5=1, success@5=1, mrr=1
    scoreQuery(["b", "c"], queries[1], [5]), // recall@5=0, success@5=0, mrr=0
  ];
  const agg = aggregate(per, queries, { lang: q => q.lang });
  assert.equal(agg.n, 2);
  close(agg.overall["recall@5"], 0.5);
  close(agg.overall.mrr, 0.5);
  assert.equal(agg.breakdowns.lang.ko.n, 1);
  close(agg.breakdowns.lang.ko["recall@5"], 1);
  close(agg.breakdowns.lang.en["recall@5"], 0);
});
