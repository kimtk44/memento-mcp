#!/usr/bin/env bash
# eval/variance.sh
#
# Measure run-to-run variance of the minimal eval-mode (design v2.1 §5/§10).
# Prescribed protocol: re-restore (PG + Redis flush + L1 rebuild) before EVERY
# repeat, so the SearchParamAdaptor never crosses its 50-sample threshold and
# read-mutations / ema / co_retrieval never carry across repeats.
#
# Decision rule: if the worst per-metric spread < gate band (recall@5 -2pt =
# 0.02), the minimal eval-mode is deterministic enough to gate on. Otherwise
# escalate to a server-side code change (readonly guard / adaptor-off).
#
# Usage: PGPASSWORD=... bash eval/variance.sh <goldset.json> [N=3]
set -euo pipefail

GOLDSET="${1:?usage: variance.sh <goldset.json> [N]}"
N="${2:-3}"
HERE="$(dirname "$0")"
OUT="${HERE}/tmp/variance"
mkdir -p "$OUT"

for i in $(seq 1 "$N"); do
  echo "=== repeat ${i}/${N}: restore + run ==="
  bash "${HERE}/restore-snapshot.sh" >/dev/null 2>&1
  POSTGRES_DB=memento_eval REDIS_DB=15 \
    node "${HERE}/run.mjs" "${GOLDSET}" --out "${OUT}/rep_${i}.json" >/dev/null 2>&1
done

python3 - "$OUT"/rep_*.json <<'PY'
import sys, json
runs = [json.load(open(f))["overall"] for f in sys.argv[1:]]
keys = ["mrr","ndcg10","recall@1","recall@5","recall@10","recall@20","success@5"]
print(f"\nvariance over {len(runs)} re-restored repeats:")
print(f"{'metric':12} {'min':>8} {'max':>8} {'spread':>8}")
worst = 0.0
for k in keys:
    v = [r[k] for r in runs]
    s = max(v) - min(v)
    worst = max(worst, s)
    print(f"{k:12} {min(v):8.4f} {max(v):8.4f} {s:8.4f}")
verdict = "GATEABLE (worst band < 0.02)" if worst < 0.02 else "ESCALATE (worst band >= 0.02 -> code-side determinism fix)"
print(f"\nworst spread = {worst:.4f}  ->  {verdict}")
PY
