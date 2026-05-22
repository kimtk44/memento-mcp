import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { MemoryRememberer } from "../../lib/memory/processors/MemoryRememberer.js";

/** detectConflicts가 호출되는지 추적하는 최소 스텁으로 구성한다. */
function makeRememberer(calls) {
  const noopAsync = async () => {};
  return new MemoryRememberer({
    store: {
      insert: async () => "frag-test-1",
      updateTtlTier: noopAsync,
    },
    index: { index: noopAsync, addToWorkingMemory: noopAsync },
    factory: { create: (p) => ({ ...p, id: undefined, keywords: p.keywords ?? [], importance: p.importance ?? 0.6 }) },
    quotaChecker: { check: noopAsync, getUsage: async () => ({}) },
    postProcessor: { run: noopAsync },
    conflictResolver: {
      detectConflicts: async () => { calls.detect++; return []; },
      autoLinkOnRemember: async () => { calls.autoLink++; },
    },
    policyRules: null,
    getHardGate: async () => false,
    policyGatingEnabled: false,
  });
}

describe("remember skipConflictDetection (비원자 경로)", () => {
  test("skipConflictDetection=true이면 detectConflicts 미호출, conflicts=[]", async () => {
    const calls = { detect: 0, autoLink: 0 };
    const r = makeRememberer(calls);
    const res = await r.remember({
      content: "정합성 테스트 파편", type: "episode", topic: "session_reflect",
      skipConflictDetection: true,
    });
    assert.equal(calls.detect, 0, "detectConflicts는 호출되지 않아야 한다");
    assert.deepEqual(res.conflicts, []);
    assert.equal(calls.autoLink, 1, "autoLinkOnRemember(정합성)는 그대로 수행되어야 한다");
  });

  test("옵션 없으면 detectConflicts 정상 호출 (기존 동작 보존)", async () => {
    const calls = { detect: 0, autoLink: 0 };
    const r = makeRememberer(calls);
    await r.remember({ content: "일반 파편", type: "fact", topic: "t" });
    assert.equal(calls.detect, 1);
  });
});
