/**
 * repair-dedup-expired-supersedes.js — GraphLinker dedup 경합으로 만료된 trunc-* 파편 복구
 *
 * 작성일: 2026-09-24
 *
 * 배경: remember(content≈X, supersedes:[X])에서 명시적 supersede가 임베딩 큐 적재 뒤에 실행돼,
 *       GraphLinker dedup 게이트(cos >= 0.95)가 아직 live인 X를 원본으로 보고 신규 파편을
 *       ~1초 뒤 만료시켰다(코드 수정: MemoryRememberer._applySupersedes 순서 + dedup 게이트 가드).
 *
 * 대상: --since(기본 오늘 00:00 UTC) 이후 생성, idempotency_key LIKE 'trunc-%', valid_to 설정,
 *       자신에게서 나가는 superseded_by 링크 없음(= 명시적 대체로 만료된 것이 아님).
 * 복구 조건: 같은 idempotency_key 접두어(끝의 "-N" 제거)를 가진 다른 live 행 중
 *       동등 내용(공백 정규화 후 동일, 또는 임베딩 cos >= 0.95 — dedup 게이트와 같은 기준)이 없을 때만.
 * 복구 동작: valid_to = NULL + 서버 FragmentIndex.index()로 Redis 재인덱싱. 행 삭제 없음.
 *       기본은 dryRun(변경 없음). 실제 반영은 --execute 필수.
 *
 * 사용:
 *   node scripts/repair-dedup-expired-supersedes.js                       # 미리보기
 *   node scripts/repair-dedup-expired-supersedes.js --since 2026-09-24    # 기준일 지정
 *   node scripts/repair-dedup-expired-supersedes.js --execute             # 실제 복구
 */

import { getPrimaryPool, shutdownPool } from "../lib/tools/db.js";
import { redisClient }                  from "../lib/redis.js";
import { getFragmentIndex }             from "../lib/memory/FragmentIndex.js";

const SCHEMA  = "agent_memory";
const args    = process.argv.slice(2);
const execute = args.includes("--execute");
const sinceIx = args.indexOf("--since");
const since   = sinceIx >= 0 ? args[sinceIx + 1] : new Date().toISOString().slice(0, 10);

/** idempotency_key 접두어: 끝의 "-<숫자>" 조각 번호를 제거한다 (trunc-restore-<X>-1 → trunc-restore-<X>-) */
export function keyPrefix(key) {
  return String(key).replace(/-\d+$/, "-");
}

/** 공백 정규화 */
export function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

async function main() {
  const pool = getPrimaryPool();
  if (!pool) {
    console.error("DB pool unavailable");
    process.exit(1);
  }

  const { rows: victims } = await pool.query(
    `SELECT f.id, f.idempotency_key, f.content, f.topic, f.type, f.keywords, f.key_id,
            f.created_at, f.valid_to, f.valid_to - f.created_at AS expired_after
       FROM ${SCHEMA}.fragments f
      WHERE f.created_at >= $1::timestamptz
        AND f.idempotency_key LIKE 'trunc-%'
        AND f.valid_to IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${SCHEMA}.fragment_links l
           WHERE l.from_id = f.id AND l.relation_type = 'superseded_by'
        )
      ORDER BY f.created_at`,
    [since]
  );

  console.log(`since=${since} candidates=${victims.length} mode=${execute ? "EXECUTE" : "dry-run"}`);

  const toRepair = [];
  for (const v of victims) {
    const prefix = keyPrefix(v.idempotency_key);
    const { rows: live } = await pool.query(
      `SELECT o.id, o.idempotency_key, o.content,
              CASE WHEN o.embedding IS NOT NULL AND v.embedding IS NOT NULL
                   THEN 1 - (o.embedding <=> v.embedding) END AS cos
         FROM ${SCHEMA}.fragments o
         JOIN ${SCHEMA}.fragments v ON v.id = $1
        WHERE o.id != $1
          AND o.valid_to IS NULL
          AND o.idempotency_key LIKE $2 || '%'
          AND o.key_id IS NOT DISTINCT FROM v.key_id`,
      [v.id, prefix]
    );

    const equivalent = live.find(o =>
      normalize(o.content) === normalize(v.content) || (o.cos != null && Number(o.cos) >= 0.95)
    );
    const dt = v.expired_after?.milliseconds != null || v.expired_after?.seconds != null
      ? `${(v.expired_after.seconds ?? 0) + (v.expired_after.milliseconds ?? 0) / 1000}s`
      : String(v.expired_after);

    if (equivalent) {
      console.log(`SKIP    ${v.id} key=${v.idempotency_key} expired_after=${dt} — live equivalent ${equivalent.id} (${equivalent.idempotency_key}, cos=${equivalent.cos == null ? "n/a" : Number(equivalent.cos).toFixed(4)})`);
      continue;
    }
    const siblings = live.map(o => `${o.id}(${o.idempotency_key})`).join(", ") || "none";
    console.log(`REPAIR  ${v.id} key=${v.idempotency_key} expired_after=${dt} live-siblings=${siblings}`);
    toRepair.push(v);
  }

  console.log(`to repair: ${toRepair.length}, skipped: ${victims.length - toRepair.length}`);

  if (execute && toRepair.length > 0) {
    if (redisClient.status === "wait") await redisClient.connect();
    const index = getFragmentIndex();
    let repaired = 0;
    for (const v of toRepair) {
      const { rowCount } = await pool.query(
        `UPDATE ${SCHEMA}.fragments SET valid_to = NULL WHERE id = $1 AND valid_to IS NOT NULL`,
        [v.id]
      );
      if (rowCount > 0) {
        await index.index(v, null, v.key_id ?? null);
        repaired++;
      }
    }
    console.log(`repaired: ${repaired} (redis ${redisClient.status})`);
  }

  if (redisClient.status === "ready") await redisClient.quit().catch(() => {});
  else redisClient.disconnect?.();
  await shutdownPool().catch(() => {});
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
