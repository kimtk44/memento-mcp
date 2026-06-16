// eval/metrics.mjs
//
// Pure IR metric functions for the offline goldset eval. NO I/O — unit-testable.
// Convention (matches lib/memory/EvaluationMetrics.computePrecisionAt): return
// `null` when a metric is undefined (query has no relevant labels), so the
// aggregator skips it rather than skewing the mean toward 0.
//
// Relevance model: relevant_ids → gain 1.0 (must-find), alternates → gain 0.5
// (acceptable, partial credit; affects nDCG only). recall@k / success@k / MRR
// key on relevant_ids only (the strict must-find set).

/** Graded relevance gain of one id. */
export function gainOf(id, relevantSet, alternateSet) {
  if (relevantSet.has(id)) return 1.0;
  if (alternateSet && alternateSet.has(id)) return 0.5;
  return 0;
}

/** recall@k = |relevant ∩ top-k| / |relevant|. */
export function recallAtK(retrieved, relevantIds, k) {
  if (!relevantIds || relevantIds.length === 0) return null;
  const rel = new Set(relevantIds);
  let hit = 0;
  for (const id of retrieved.slice(0, k)) if (rel.has(id)) hit++;
  return hit / rel.size;
}

/** success@k = 1 if ≥1 relevant in top-k else 0 (interpretable for memory recall). */
export function successAtK(retrieved, relevantIds, k) {
  if (!relevantIds || relevantIds.length === 0) return null;
  const rel = new Set(relevantIds);
  return retrieved.slice(0, k).some(id => rel.has(id)) ? 1 : 0;
}

/** Reciprocal rank of the first relevant hit (0 if none retrieved). */
export function reciprocalRank(retrieved, relevantIds) {
  if (!relevantIds || relevantIds.length === 0) return null;
  const rel = new Set(relevantIds);
  for (let i = 0; i < retrieved.length; i++) if (rel.has(retrieved[i])) return 1 / (i + 1);
  return 0;
}

/** nDCG@k with graded gains (relevant=1.0, alternate=0.5). DCG / ideal-DCG. */
export function ndcgAtK(retrieved, relevantIds, k, alternates = []) {
  if (!relevantIds || relevantIds.length === 0) return null;
  const rel = new Set(relevantIds);
  const alt = new Set((alternates || []).filter(id => !rel.has(id)));

  let dcg = 0;
  const topK = retrieved.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const g = gainOf(topK[i], rel, alt);
    if (g > 0) dcg += g / Math.log2(i + 2); // rank i (0-based) → discount log2(i+2)
  }

  // Ideal: all gains sorted desc, take top-k.
  const idealGains = [...Array(rel.size).fill(1.0), ...Array(alt.size).fill(0.5)]
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealGains.length; i++) idcg += idealGains[i] / Math.log2(i + 2);

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Score one goldset query against a retrieved id list.
 * @param {string[]} retrieved - ranked fragment ids from recall()
 * @param {{qid, relevant_ids, alternates?}} q
 * @param {number[]} ks
 * @returns {Object} flat metric map (null where undefined)
 */
export function scoreQuery(retrieved, q, ks = [1, 3, 5, 10, 20]) {
  const out = {
    qid   : q.qid,
    mrr   : reciprocalRank(retrieved, q.relevant_ids),
    ndcg10: ndcgAtK(retrieved, q.relevant_ids, 10, q.alternates),
  };
  for (const k of ks) {
    out[`recall@${k}`]  = recallAtK(retrieved, q.relevant_ids, k);
    out[`success@${k}`] = successAtK(retrieved, q.relevant_ids, k);
  }
  return out;
}

/** Mean over non-null values (null if none). */
export function meanOf(vals) {
  const v = vals.filter(x => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Aggregate per-query scores → overall means + breakdowns by dimension.
 * @param {Object[]} perQuery - scoreQuery() outputs, aligned with `queries`
 * @param {Object[]} queries  - goldset entries (for breakdown key extraction)
 * @param {Object<string,function>} keyFns - dim → (query)=>group label (e.g. {lang:q=>q.lang})
 */
export function aggregate(perQuery, queries, keyFns = {}) {
  const metricKeys = perQuery.length
    ? Object.keys(perQuery[0]).filter(m => m !== "qid")
    : [];

  const overall = {};
  for (const m of metricKeys) overall[m] = meanOf(perQuery.map(p => p[m]));

  const breakdowns = {};
  for (const [dim, fn] of Object.entries(keyFns)) {
    const groups = {};
    perQuery.forEach((p, i) => {
      const g = fn(queries[i]) ?? "(none)";
      (groups[g] ||= []).push(p);
    });
    breakdowns[dim] = {};
    for (const [g, rows] of Object.entries(groups)) {
      const cell = { n: rows.length };
      for (const m of metricKeys) cell[m] = meanOf(rows.map(r => r[m]));
      breakdowns[dim][g] = cell;
    }
  }

  return { n: perQuery.length, overall, breakdowns };
}
