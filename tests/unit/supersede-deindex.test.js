/**
 * valid_to 만료 경로의 Redis deindex 연동 단위 테스트
 *
 * 작성일: 2026-09-24
 *
 * 배경: supersede는 PG에서 valid_to만 세팅하고 Redis 역인덱스·Hot Cache를 비우지 않아,
 * Hot Cache의 valid_to=null 스냅샷이 L1 → HotCache 경로로 recall 결과에 재유입됐다.
 *
 * 검증 항목:
 * 1. ConflictResolver.supersede: UPDATE ... RETURNING 행을 deindexExpired로 넘긴다
 * 2. ConflictResolver.supersede: 이미 만료된 파편(0행)은 빈 배열로 호출(무해)
 * 3. ContradictionDetector.resolveContradiction: 패자 파편을 deindexExpired로 넘긴다
 * 4. GraphLinker.linkFragment: 완전 중복(cos>=0.95) soft delete 시 deindexExpired 호출
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** db.js mock — SQL별 응답을 테스트가 교체한다 */
const dbState = { handler: async () => ({ rows: [] }), calls: [] };
const fakeQuery = async (sql, params) => {
  dbState.calls.push({ sql, params });
  return dbState.handler(sql, params);
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool       : () => ({ query: fakeQuery }),
    getBatchPool         : () => ({ query: fakeQuery }),
    shutdownPool         : async () => {},
    getPoolStats         : () => ({}),
    queryWithAgentVector : async (_agentId, sql, params) => fakeQuery(sql, params),
    withTransaction      : async (_pool, fn) => fn({ query: fakeQuery })
  }
});

/** FragmentIndex mock — deindexExpired 호출 기록 */
const deindexCalls = [];
const fakeIndex = {
  deindexExpired: async (rows) => { deindexCalls.push(rows); },
  deindex       : async () => {},
  index         : async () => {}
};

mock.module("../../lib/memory/FragmentIndex.js", {
  namedExports: {
    getFragmentIndex: () => fakeIndex,
    FragmentIndex   : class {}
  }
});

const { ConflictResolver }      = await import("../../lib/memory/write/ConflictResolver.js");
const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");
const { GraphLinker }           = await import("../../lib/memory/link/GraphLinker.js");

const mockStore = () => ({ createLink: async () => {} });

const OLD_ROW = {
  id: "frag-old", keywords: ["memos", "dual-bind"], topic: "t", type: "fact", key_id: null
};

beforeEach(() => {
  deindexCalls.length = 0;
  dbState.calls.length = 0;
  dbState.handler = async () => ({ rows: [] });
});

describe("ConflictResolver.supersede — Redis deindex", () => {
  it("UPDATE RETURNING 행을 deindexExpired로 전달한다", async () => {
    dbState.handler = async (sql) =>
      /UPDATE agent_memory\.fragments/.test(sql) ? { rows: [OLD_ROW] } : { rows: [] };

    const cr = new ConflictResolver(mockStore(), null);
    await cr.supersede("frag-old", "frag-new", "default", null);

    const upd = dbState.calls.find(c => /SET valid_to/.test(c.sql));
    assert.ok(upd, "valid_to UPDATE 필수");
    assert.match(upd.sql, /RETURNING id, keywords, topic, type, key_id/);
    assert.deepStrictEqual(deindexCalls, [[OLD_ROW]]);
  });

  it("이미 만료된 파편(0행)이면 빈 배열로 호출한다", async () => {
    const cr = new ConflictResolver(mockStore(), null);
    await cr.supersede("frag-old", "frag-new", "default", null);
    assert.deepStrictEqual(deindexCalls, [[]]);
  });
});

describe("ContradictionDetector.resolveContradiction — Redis deindex", () => {
  it("구 파편 만료 시 deindexExpired를 호출한다", async () => {
    dbState.handler = async (sql) =>
      /SET valid_to/.test(sql) ? { rows: [OLD_ROW] } : { rows: [] };

    const d = new ContradictionDetector(mockStore());
    const newFrag = { id: "frag-new", created_at: "2026-09-24T00:00:00Z", key_id: null, content: "n" };
    const oldFrag = { id: "frag-old", created_at: "2026-09-01T00:00:00Z", key_id: null, content: "o", is_anchor: true };

    /** 후속 remember(모순 해결 기록)는 MemoryManager 의존 — 실패해도 deindex는 이미 끝난 뒤다 */
    await d.resolveContradiction(newFrag, oldFrag, "test").catch(() => {});

    assert.ok(deindexCalls.some(rows => rows?.[0]?.id === "frag-old"),
      `frag-old deindex 누락: ${JSON.stringify(deindexCalls)}`);
  });
});

describe("GraphLinker.linkFragment — Redis deindex", () => {
  it("완전 중복 soft delete 시 deindexExpired를 호출한다", async () => {
    const dupRow = { ...OLD_ROW, id: "frag-dup" };
    dbState.handler = async (sql) => {
      if (/SELECT id, content, topic, type, created_at/.test(sql)) {
        return { rows: [{ id: "frag-dup", content: "x", topic: "t", type: "fact", created_at: new Date() }] };
      }
      if (/AS similarity/.test(sql)) return { rows: [{ id: "frag-exist", similarity: "0.99" }] };
      if (/SET valid_to/.test(sql))   return { rows: [dupRow] };
      return { rows: [] };
    };

    const gl = new GraphLinker();
    gl.store = mockStore();
    await gl.linkFragment("frag-dup", "default").catch(() => {});

    const upd = dbState.calls.find(c => /SET valid_to/.test(c.sql));
    assert.ok(upd, `valid_to UPDATE 미도달. SQL: ${dbState.calls.map(c => c.sql.slice(0, 60)).join(" | ")}`);
    assert.ok(deindexCalls.some(rows => rows?.[0]?.id === "frag-dup"),
      `frag-dup deindex 누락: ${JSON.stringify(deindexCalls)}`);
  });
});
