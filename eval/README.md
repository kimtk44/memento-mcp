# Memento offline goldset eval (Phase 1)

Deterministic, reproducible retrieval regression gate for `MemoryManager.recall()`.
Design SSOT: vault `02 Projects/LLM-Server/memento-eval-harness-phase1-design-2026-06-16.md` (v2.1).

## What it does
Scores a labelled goldset (query → relevant fragment ids) against `recall()` running
on an **isolated snapshot** of the live corpus, producing recall@k / MRR / nDCG /
success@k with lang / query_type / difficulty / hard_case breakdowns. Used to gate
Phase 2 retrieval changes (morpheme hybrid, doc2query, reranker tuning).

## Isolation + determinism (minimal eval-mode)
- **Corpus** = `pg_dump --schema=agent_memory` of live `memento` restored into a
  separate DB `memento_eval` (real distractors/geometry; already embedded).
- **Redis** = dedicated db index 15, FLUSHed + L1 rebuilt from the snapshot each
  restore (L1/HotCache are Redis-resident; PG restore alone is NOT enough).
- **eval-mode** = no sessionId + keyId=null + pinned `asOf` + scheduler not booted
  (harness imports MemoryManager directly) + id sort tiebreak. Re-restore before
  every repeat so the SearchParamAdaptor never crosses 50 samples.
- Verified GATEABLE: keyword path 0.0000 run-to-run spread (see `variance.sh`).
- Residual nondeterminism (reranker `Date.now`, HNSW approx) absorbed as a
  tolerance band (gate band default 0.02).

## Files
| file | role |
|---|---|
| `restore-snapshot.sh` | build the isolated eval env (PG restore + Redis flush/rebuild + migration-038) |
| `rebuild-redis-l1.mjs` | rebuild Redis L1 index from the restored snapshot |
| `metrics.mjs` | pure IR metric functions (unit-tested: `tests/unit/eval-metrics.test.js`) |
| `run.mjs` | score a goldset → report JSON |
| `compare.mjs` | regression gate: candidate vs baseline (exit 1 on regression) |
| `variance.sh` | run-to-run variance over N re-restored repeats |
| `goldset/phase1.json` | 24-query goldset (DEV/TEST/PROBE, dual distribution) |
| `goldset/smoke.json` | 5-query keyword smoke set |
| `baseline.json` | frozen reference baseline (= post-bugfix) |

## Workflow
```bash
export PGPASSWORD=...
# 1. build isolated env
bash eval/restore-snapshot.sh
# 2. score the goldset
POSTGRES_DB=memento_eval REDIS_DB=15 node eval/run.mjs eval/goldset/phase1.json --out /tmp/cand.json
# 3. gate against baseline
node eval/compare.mjs eval/baseline.json /tmp/cand.json
# variance / band check
bash eval/variance.sh eval/goldset/phase1.json 3
```

## Baseline state (2026-06-16, post-bugfix)
overall recall@20 = 0.625, recall@5 = 0.292, mrr = 0.304.
- keyword recall@20 = 0.923 (L1/L2 healthy).
- text/semantic recall@20 = 0.200 — genuine semantic-ranking quality gap
  (HNSW-approx / reranker / RRF), **the Phase 2 target** (not a bug).

The first baseline run surfaced (and we fixed) two retrieval bugs:
1. `hnsw.iterative_scan` (pgvector 0.8+ param) set on pgvector 0.6.0 → L3 dead.
   Gated behind `MEMENTO_HNSW_ITERATIVE_SCAN=on`.
2. `morpheme_dict` was vector(1536) vs bge-m3 1024 → morpheme INSERT failed.
   Fixed by migration-038. Both were upstream-origin (re-applied as fork patches).

## Deferred (Phase 1 step 6 — diagnostic depth, not yet built)
- per-stage ablation (L2/L3/L4 isolation recall via direct layer calls; L1 needs
  the Redis rebuild routine).
- reranker uplift (pre-rerank vs full `recall()` Recall@10, scoped to text/mixed;
  `RERANKER_URL=''` does NOT disable L4 — it falls back to in-process ONNX).
