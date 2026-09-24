/**
 * deindex-expired-fragments.js — 만료(valid_to 설정) 파편의 Redis 역인덱스·Hot Cache 일괄 제거
 *
 * 작성일: 2026-09-24
 *
 * 배경: supersede·dedup·모순 해소·분할 경로가 PG에서 valid_to만 세팅하고 Redis를 비우지 않아,
 *       Hot Cache의 valid_to=null 스냅샷이 recall 결과에 재유입됐다(코드 수정은 FragmentIndex.deindexExpired).
 *       이 스크립트는 수정 이전에 누적된 잔존분을 서버와 동일한 FragmentIndex 코드로 정리한다.
 * 규칙: 파편 행은 삭제·수정하지 않는다(SELECT만). Redis 키만 제거한다.
 *       기본은 dryRun(변경 없음). 실제 제거는 --execute 필수.
 *
 * 사용:
 *   node scripts/deindex-expired-fragments.js            # 미리보기 (Hot Cache 잔존 건수 표시)
 *   node scripts/deindex-expired-fragments.js --execute  # 실제 제거
 */

import { getPrimaryPool, shutdownPool } from "../lib/tools/db.js";
import { redisClient }                  from "../lib/redis.js";
import { getFragmentIndex }             from "../lib/memory/FragmentIndex.js";

const SCHEMA  = "agent_memory";
const execute = process.argv.slice(2).includes("--execute");

/** Hot Cache 잔존 건수 (조회자 네임스페이스 "_g" + 파편 key_id 네임스페이스) */
async function countHotResidue(rows) {
  let n = 0;
  for (const r of rows) {
    const keys = [`frag:hot:_g:${r.id}`];
    if (r.key_id != null) keys.push(`frag:hot:_k${r.key_id}:${r.id}`);
    for (const k of keys) {
      if (await redisClient.exists(k)) n++;
    }
  }
  return n;
}

async function main() {
  const pool = getPrimaryPool();
  if (!pool) {
    console.error("DB pool unavailable");
    process.exit(1);
  }

  /** lazyConnect 클라이언트 — FragmentIndex는 status==="ready"가 아니면 no-op이므로 명시 연결 */
  if (redisClient.status === "wait") await redisClient.connect();
  if (redisClient.status !== "ready") {
    console.error(`Redis not ready (status=${redisClient.status})`);
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, keywords, topic, type, key_id
       FROM ${SCHEMA}.fragments
      WHERE valid_to IS NOT NULL`
  );

  const before = await countHotResidue(rows);
  console.log(`expired fragments: ${rows.length}, hot-cache residue: ${before}`);

  if (!execute) {
    console.log("dry-run — pass --execute to deindex");
  } else {
    await getFragmentIndex().deindexExpired(rows);
    const after = await countHotResidue(rows);
    console.log(`deindexed ${rows.length} fragments, hot-cache residue after: ${after}`);
  }

  await redisClient.quit().catch(() => {});
  await shutdownPool().catch(() => {});
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
