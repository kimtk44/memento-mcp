// eval/run.mjs
//
// Single-pass offline goldset scorer. For each goldset query, calls
// MemoryManager.recall() against the isolated eval DB under eval-mode controls
// (no sessionId, keyId=null, pinned asOf) and scores the ranked fragment ids
// against the query's relevant_ids. Prints an aggregate report JSON.
//
// Run isolated (see restore-snapshot.sh): the caller MUST set
//   POSTGRES_DB=memento_eval REDIS_DB=15
// so recall() hits the snapshot DB + eval Redis index, never the live ones.
//
// Usage: POSTGRES_DB=memento_eval REDIS_DB=15 node eval/run.mjs <goldset.json> [--asof ISO] [--out report.json]

import { readFileSync, writeFileSync } from "node:fs";
import { MemoryManager } from "../lib/memory/MemoryManager.js";
import { redisClient, disconnectRedis } from "../lib/redis.js";
import { scoreQuery, aggregate } from "./metrics.mjs";

const KS        = [1, 3, 5, 10, 20];
const DEFAULT_ASOF = "2026-06-16T12:00:00.000Z"; // pin anchorTime -> deterministic temporalProximity
const PAGE_SIZE = 50;                            // need >= max(KS) ranked ids

function parseArgs(argv) {
  const a = { goldset: null, asof: DEFAULT_ASOF, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--asof") a.asof = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (!a.goldset) a.goldset = argv[i];
  }
  return a;
}

/** Map a goldset entry to recall() params (eval-mode: no sessionId, keyId null). */
function recallParams(q, asof) {
  const base = { keyId: null, asOf: asof, pageSize: PAGE_SIZE, tokenBudget: 12000, excludeSeen: false };
  switch (q.query_type) {
    case "keywords": return { ...base, keywords: q.query.split(/\s+/).filter(Boolean) };
    case "topic":    return { ...base, topic: q.query };
    case "mixed":    return { ...base, text: q.query, keywords: q.query.split(/\s+/).filter(Boolean) };
    case "text":
    default:         return { ...base, text: q.query };
  }
}

async function ensureRedis() {
  if (redisClient.status === "wait" || redisClient.status === "end") await redisClient.connect();
  const pong = await redisClient.ping();
  if (pong !== "PONG") throw new Error(`Redis not ready (status=${redisClient.status})`);
}

async function main() {
  if (process.env.POSTGRES_DB !== "memento_eval") {
    console.error(`[run] refusing: POSTGRES_DB="${process.env.POSTGRES_DB}" (expected memento_eval).`);
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.goldset) { console.error("[run] usage: run.mjs <goldset.json> [--asof ISO] [--out file]"); process.exit(1); }

  const queries = JSON.parse(readFileSync(args.goldset, "utf8"));
  await ensureRedis();
  const mm = MemoryManager.getInstance();

  const perQuery = [];
  for (const q of queries) {
    const res       = await mm.recall(recallParams(q, args.asof));
    const retrieved = (res.fragments || []).map(f => f.id);
    perQuery.push(scoreQuery(retrieved, q, KS));
  }

  const report = aggregate(perQuery, queries, {
    lang      : q => q.lang,
    query_type: q => q.query_type,
    difficulty: q => q.difficulty,
    hard_case : q => q.hard_case ?? "none",
  });
  report.asof    = args.asof;
  report.goldset = args.goldset;

  const json = JSON.stringify(report, null, 2);
  if (args.out) { writeFileSync(args.out, json); console.error(`[run] report -> ${args.out}`); }
  console.log(json);

  await disconnectRedis().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("[run] fatal:", e); process.exit(1); });
