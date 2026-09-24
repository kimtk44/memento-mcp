/**
 * [fork-patch, v5.10.0 cutover] Only the expired-row revive part of fork 4eb2311 is carried.
 * The ordering and NOT EXISTS guard parts are superseded by the v5.10.0 GraphLinker gate
 * (exact content match) together with the content_hash unique index, so their tests are dropped.
 */
/**
 * 명시적 supersede 신규 파편이 ~1초 뒤 만료되던 경합 + 만료 파편 content_hash 반환 단위 테스트
 *
 * 작성일: 2026-09-24
 *
 * 배경(실측): remember(content≈X, supersedes:[X]) 직후 EmbeddingWorker → GraphLinker 의
 * dedup 게이트(cos >= 0.95)가 아직 live인 X를 원본으로 보고 신규 파편을 만료시켰다.
 * 명시적 supersede는 postProcessor/충돌감지/autoLink 뒤에 실행돼 ~1.5초 늦었다.
 * 이후 같은 내용 재전송은 content_hash dedup이 만료 id를 그대로 돌려줬다.
 *
 * 검증 항목:
 * 1. _persistNonAtomic / _finalizeRemember: supersede가 postProcessor.run(임베딩 큐)보다 먼저
 * 2. GraphLinker dedup 게이트: 신규 파편이 superseded_by로 대체한 파편은 후보에서 제외
 * 3. FragmentWriter._runInsert: 만료 파편 content_hash hit → 부활(valid_to=NULL) 후 id 반환
 * 4. FragmentWriter._runInsert: live 파편 hit → 부활 UPDATE 없음
 * 5. INSERT ON CONFLICT 경합 경로도 valid_to = NULL
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

const { FragmentWriter }   = await import("../../lib/memory/write/FragmentWriter.js");

beforeEach(() => {
  dbState.calls.length = 0;
  dbState.handler = async () => ({ rows: [] });
});

describe("FragmentWriter content_hash dedup — 만료 파편 부활", () => {
  const row = () => new FragmentWriter()._prepareInsertRow({
    id: "frag-fresh", content: "same content", topic: "t", type: "fact", importance: 0.7, agent_id: "default"
  });

  it("만료 hit는 valid_to를 해제하고 그 id를 반환한다", async () => {
    dbState.handler = async (sql) => /SELECT id, valid_to/.test(sql)
      ? { rows: [{ id: "frag-dead", valid_to: new Date() }] }
      : { rows: [] };
    const id = await new FragmentWriter()._runInsert(undefined, row());
    assert.strictEqual(id, "frag-dead");
    const revive = dbState.calls.find(c => /SET valid_to\s+= NULL/.test(c.sql) && /UPDATE/.test(c.sql));
    assert.ok(revive, `부활 UPDATE 미실행: ${dbState.calls.map(c => c.sql.slice(0, 50)).join(" | ")}`);
    /** importance는 insert 경로와 동일하게 sanitize된 요청값(insertParams[5])을 쓴다 */
    assert.deepStrictEqual(revive.params, ["frag-dead", row().insertParams[5]]);
  });

  it("live hit는 부활 UPDATE 없이 id만 반환한다", async () => {
    dbState.handler = async (sql) => /SELECT id, valid_to/.test(sql)
      ? { rows: [{ id: "frag-live", valid_to: null }] }
      : { rows: [] };
    const id = await new FragmentWriter()._runInsert(undefined, row());
    assert.strictEqual(id, "frag-live");
    assert.ok(!dbState.calls.some(c => /UPDATE/.test(c.sql)));
  });

  it("INSERT ON CONFLICT 경합 경로도 valid_to = NULL", () => {
    assert.match(row().insertSql, /ON CONFLICT[\s\S]*valid_to\s+= NULL/);
  });
});
