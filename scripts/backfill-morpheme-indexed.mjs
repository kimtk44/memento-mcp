#!/usr/bin/env node
/**
 * backfill-morpheme-indexed.mjs — morpheme_indexed=false 백로그 일괄 인덱싱
 *
 * 작성일: 2026-07-17
 *
 * 목적: batch_remember/reflect 경로가 morpheme 등록·마킹을 누락해 2026-06-16부터
 * 쌓인 morpheme_indexed=false 파편(발견 시점 348개)을 일괄 처리한다.
 * 체인은 RememberPostProcessor Phase 4와 동일: tokenize → getOrRegisterEmbeddings
 * → morpheme_indexed=true. 재실행 안전(idempotent — 이미 true인 파편은 대상 제외).
 *
 * 사용:
 *   node scripts/backfill-morpheme-indexed.mjs --dry-run   # 대상 목록만 출력
 *   node scripts/backfill-morpheme-indexed.mjs             # 실제 인덱싱
 *   POSTGRES_DB=memento_eval node scripts/... # eval DB 대상 테스트
 *
 * 의존: DB 접속(env), 임베딩 서버(:8081). 서비스 재시작 불필요(라이브 DB에 직접).
 */

import { getPrimaryPool } from "../lib/tools/db.js";
import { MorphemeIndex }  from "../lib/memory/MorphemeIndex.js";

const SCHEMA  = "agent_memory";
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const pool = getPrimaryPool();
  const morphemeIndex = new MorphemeIndex();

  const { rows } = await pool.query(
    `SELECT id, created_at::date AS d, length(content) AS len
     FROM ${SCHEMA}.fragments
     WHERE morpheme_indexed = false AND valid_to IS NULL
     ORDER BY created_at`
  );
  console.log(`morpheme_indexed=false active fragments: ${rows.length}${DRY_RUN ? " (dry-run, no writes)" : ""}`);
  if (DRY_RUN || rows.length === 0) {
    for (const r of rows.slice(0, 20)) console.log(`  ${r.id}  ${r.d.toISOString().slice(0, 10)}  len=${r.len}`);
    if (rows.length > 20) console.log(`  ... +${rows.length - 20} more`);
    process.exit(0);
  }

  let ok = 0, fail = 0;
  for (const [i, r] of rows.entries()) {
    try {
      const { rows: frag } = await pool.query(
        `SELECT content FROM ${SCHEMA}.fragments WHERE id = $1`, [r.id]);
      const morphemes = await morphemeIndex.tokenize(frag[0]?.content ?? "").catch(() => []);
      await morphemeIndex.getOrRegisterEmbeddings(morphemes);
      await pool.query(
        `UPDATE ${SCHEMA}.fragments SET morpheme_indexed = true WHERE id = $1`, [r.id]);
      ok++;
    } catch (err) {
      fail++;
      console.error(`FAIL ${r.id}: ${err.message}`);
    }
    if ((i + 1) % 50 === 0) console.log(`  progress ${i + 1}/${rows.length} (ok=${ok} fail=${fail})`);
  }
  console.log(`done: ok=${ok} fail=${fail} of ${rows.length}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
