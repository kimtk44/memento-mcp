/**
 * Fork patches on the external reranker path (re-applied at the v5.10.0 cutover).
 *
 *  1. TEI-array scores are raw logits from llama.cpp; they must be sigmoid-normalized,
 *     otherwise `score * recencyBoost` ranks a recent negative logit below an older one.
 *  2. A 4xx/500 is a per-request failure (e.g. oversized payload) and must not count
 *     toward the 3-failure service-down streak that puts every query into cooldown.
 *  3. With fallback=skip, a failed /health at preload must not latch the module into
 *     in-process mode (with in-process disabled that silently disables reranking).
 *
 * RERANKER_URL is set before the module is imported; node --test runs each file in its
 * own process, so this does not leak into other suites.
 */

process.env.RERANKER_URL               = "http://reranker.test";
process.env.RERANKER_EXTERNAL_FALLBACK = "skip";

import { describe, it, mock, afterEach } from "node:test";
import assert                            from "node:assert/strict";

const { rerank, preloadReranker, isRerankerAvailable } = await import("../../lib/memory/read/Reranker.js");

const candidates = [
  { id: "old",   content: "older doc",  created_at: "2026-01-01" },
  { id: "new",   content: "newer doc",  created_at: "2026-09-20" },
  { id: "other", content: "other doc",  created_at: "2026-05-01" }
];

function jsonResponse(status, body) {
  return {
    ok:     status >= 200 && status < 300,
    status,
    json:   async () => body,
    text:   async () => JSON.stringify(body)
  };
}

describe("reranker fork patches", () => {
  afterEach(() => { mock.restoreAll(); });

  it("preload /health failure in skip mode keeps external mode", async () => {
    mock.method(globalThis, "fetch", async () => { throw new Error("ECONNREFUSED"); });
    await preloadReranker();
    assert.equal(isRerankerAvailable(), true, "must stay external and available");
  });

  it("sigmoid-normalizes TEI logits so negative scores rank below positive ones", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse(200, [
      { index: 0, score:  3.0 },
      { index: 1, score: -1.8 },
      { index: 2, score:  0.5 }
    ]));
    const out = await rerank("q", candidates, 15);
    assert.deepEqual(out.map(c => c.id), ["old", "other", "new"]);
    for (const c of out) {
      assert.ok(c.rerankerScore > 0, `score must be positive after sigmoid, got ${c.rerankerScore}`);
    }
  });

  it("500 responses do not trip the service-down cooldown", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(500, { error: "too large" }));
    for (let i = 0; i < 5; i++) {
      const out = await rerank("q", candidates, 15);
      assert.deepEqual(out.map(c => c.id), ["old", "new", "other"], "original order on failure");
    }
    assert.equal(fetchMock.mock.callCount(), 5, "every request still reaches external (no cooldown)");
    assert.equal(isRerankerAvailable(), true);
  });

  it("truncates oversized documents before sending", async () => {
    let sent;
    mock.method(globalThis, "fetch", async (_url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse(200, [{ index: 0, score: 1 }]);
    });
    await rerank("q", [{ id: "big", content: "x".repeat(9000), created_at: "2026-09-01" }], 15);
    assert.ok(sent.documents[0].length <= 6000, `payload doc length ${sent.documents[0].length}`);
  });
});
