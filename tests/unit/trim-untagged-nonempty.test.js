/**
 * [fork-patch] _trimToTokenBudget untagged path (text-only recall, e.g. the UserPromptSubmit hook
 * with tokenBudget 600): an over-budget head must be skipped, not end the packing, and a tight
 * budget must degrade to fewer results rather than none.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";

describe("untagged trim keeps smaller candidates behind an over-budget head", () => {
  const search = Object.create(FragmentSearch.prototype);

  it("skips the oversized head and packs the smaller ones", () => {
    const big   = { id: "big",   content: "b", estimated_tokens: 900 };
    const small = { id: "small", content: "s", estimated_tokens: 100 };
    const mid   = { id: "mid",   content: "m", estimated_tokens: 300 };
    const ids = search._trimToTokenBudget([big, small, mid], 600).map(f => f.id);
    assert.deepEqual(ids, ["small", "mid"]);
  });

  it("admits the single smallest candidate when every one exceeds the budget", () => {
    const a = { id: "a", content: "a", estimated_tokens: 900 };
    const b = { id: "b", content: "b", estimated_tokens: 700 };
    const ids = search._trimToTokenBudget([a, b], 600).map(f => f.id);
    assert.deepEqual(ids, ["b"]);
  });

  it("empty input stays empty", () => {
    assert.deepEqual(search._trimToTokenBudget([], 600), []);
  });
});
