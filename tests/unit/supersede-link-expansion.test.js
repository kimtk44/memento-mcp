/**
 * supersede 이후 만료 파편 재유입 차단 + forget topic dryRun 단위 테스트
 *
 * 작성일: 2026-09-24
 *
 * 배경: Redis deindex(cb9aa7b) 이후에도 recall의 includeLinks 1-hop 확장이 만료 파편을
 * 되살렸다. GraphLinker가 만료 파편을 후보로 잡아 related 링크를 upsert하면서
 * superseded_by 관계를 덮어썼고, getLinkedFragments는 valid_to를 거르지 않았다.
 * 또 forget(topic, dryRun:true)는 dryRun을 무시하고 실제 삭제했다.
 *
 * 검증 항목:
 * 1. getLinkedFragments: 기본은 양쪽 UNION 절 모두 f.valid_to IS NULL, includeSuperseded면 미적용
 * 2. MemoryRecaller.recall: includeSuperseded를 getLinkedFragments opts로 전달
 * 3. createLink / createLinks: ON CONFLICT가 기존 superseded_by를 유지
 * 4. GraphLinker 후보 쿼리: 만료 파편 제외
 * 5. forget(topic, dryRun:true): 삭제·deindex 없이 삭제 예정 목록 반환
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

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

const { LinkStore }        = await import("../../lib/memory/link/LinkStore.js");
const { GraphLinker }      = await import("../../lib/memory/link/GraphLinker.js");
const { MemoryRecaller }   = await import("../../lib/memory/processors/MemoryRecaller.js");
const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

beforeEach(() => {
  dbState.calls.length = 0;
  dbState.handler = async () => ({ rows: [] });
});

const countValidFilter = (sql) => (sql.match(/f\.valid_to IS NULL/g) || []).length;

describe("LinkStore.getLinkedFragments — 만료 파편 필터", () => {
  it("기본: 양방향 UNION 절 모두 f.valid_to IS NULL", async () => {
    await new LinkStore().getLinkedFragments(["frag-b"], null, "default", null, {});
    assert.strictEqual(countValidFilter(dbState.calls[0].sql), 2);
  });

  it("includeSuperseded:true: valid_to 필터 없음", async () => {
    await new LinkStore().getLinkedFragments(["frag-b"], null, "default", null, { includeSuperseded: true });
    assert.strictEqual(countValidFilter(dbState.calls[0].sql), 0);
  });
});

describe("MemoryRecaller.recall — includeSuperseded 전달", () => {
  for (const flag of [undefined, true]) {
    it(`includeSuperseded=${flag} → getLinkedFragments opts.includeSuperseded=${flag === true}`, async () => {
      let captured = null;
      const store = {
        getLinkedFragments: async (_ids, _rel, _agent, _keys, opts) => { captured = opts; return []; }
      };
      const search = {
        search: async () => ({ fragments: [{ id: "frag-b", content: "b", importance: 0.5 }], totalTokens: 1, searchPath: "L1" })
      };
      const r = new MemoryRecaller({ store, search, index: {} });
      await r.recall({ keywords: ["k"], includeSuperseded: flag }).catch(() => {});
      assert.ok(captured, "getLinkedFragments 미호출");
      assert.strictEqual(captured.includeSuperseded, flag === true);
    });
  }
});

describe("LinkStore upsert — superseded_by 보존", () => {
  it("createLink ON CONFLICT가 기존 superseded_by를 유지한다", async () => {
    await new LinkStore().createLink("frag-a", "frag-b", "related", "default");
    const ins = dbState.calls.find(c => /INSERT INTO agent_memory\.fragment_links/.test(c.sql));
    assert.ok(ins, "INSERT 미실행");
    assert.match(ins.sql, /CASE WHEN agent_memory\.fragment_links\.relation_type = 'superseded_by'/);
    assert.doesNotMatch(ins.sql, /SET relation_type = EXCLUDED\.relation_type/);
  });

  it("createLinks(batch) ON CONFLICT도 동일", async () => {
    dbState.handler = async (sql) => /RETURNING id/.test(sql) ? { rows: [{ id: 1 }] } : { rows: [] };
    await new LinkStore().createLinks([{ fromId: "frag-a", toId: "frag-b", relationType: "related" }], "default");
    const ins = dbState.calls.find(c => /INSERT INTO agent_memory\.fragment_links/.test(c.sql));
    assert.ok(ins, "INSERT 미실행");
    assert.match(ins.sql, /CASE WHEN agent_memory\.fragment_links\.relation_type = 'superseded_by'/);
  });
});

describe("GraphLinker.linkFragment — 만료 후보 제외", () => {
  it("유사 후보 쿼리가 valid_to IS NULL을 포함한다", async () => {
    dbState.handler = async (sql) => {
      if (/SELECT id, content, topic, type, created_at/.test(sql)) {
        return { rows: [{ id: "frag-b", content: "x", topic: "t", type: "fact", created_at: new Date() }] };
      }
      return { rows: [] };
    };
    const gl = new GraphLinker();
    gl.store = { createLink: async () => {} };
    await gl.linkFragment("frag-b", "default");
    const cand = dbState.calls.find(c => /> 0\.7/.test(c.sql));
    assert.ok(cand, "후보 쿼리 미실행");
    assert.match(cand.sql, /valid_to IS NULL/);
  });
});

describe("MemoryRememberer.forget — topic dryRun", () => {
  it("topic + dryRun:true는 삭제·deindex 없이 목록만 반환한다", async () => {
    const deleted = [];
    const deindexed = [];
    const store = {
      searchByTopic: async () => ([
        { id: "frag-a", type: "fact", ttl_tier: "cold", valid_to: "2026-09-24T00:00:00Z", key_id: null },
        { id: "frag-b", type: "fact", ttl_tier: "cold", valid_to: null, key_id: null }
      ]),
      deleteMany: async (ids) => { deleted.push(...ids); return ids.length; },
      delete    : async (id)  => { deleted.push(id); return true; }
    };
    const index = { deindex: async (id) => { deindexed.push(id); } };
    const rm = new MemoryRememberer({ store, index });

    const res = await rm.forget({ topic: "probe-topic", dryRun: true });

    assert.deepStrictEqual(deleted, [], "dryRun인데 삭제됨");
    assert.deepStrictEqual(deindexed, [], "dryRun인데 deindex됨");
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.simulated.would_delete_count, 2);
    assert.deepStrictEqual(res.simulated.would_delete.map(f => f.id), ["frag-a", "frag-b"]);
  });

  it("topic + dryRun 미지정은 기존대로 삭제한다", async () => {
    const deleted = [];
    const store = {
      searchByTopic: async () => ([{ id: "frag-a", type: "fact", ttl_tier: "cold", key_id: null }]),
      deleteMany   : async (ids) => { deleted.push(...ids); return ids.length; }
    };
    const rm = new MemoryRememberer({ store, index: { deindex: async () => {} } });
    const res = await rm.forget({ topic: "probe-topic" });
    assert.deepStrictEqual(deleted, ["frag-a"]);
    assert.strictEqual(res.deleted, 1);
  });
});
