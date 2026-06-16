// eval/rebuild-redis-l1.mjs
//
// Rebuild the Redis L1 inverted index from the restored Postgres snapshot.
// After `pg_dump | restore` into memento_eval + FLUSHDB, the eval Redis DB is
// empty while the live Redis index is stale vs the dump. recall()'s L1 layer
// (keyword/topic/type/recent) is Redis-resident, so without this rebuild L1
// returns nothing (or stale phantom IDs). See eval design v2.1 §5 RT-1.
//
// Isolation: invoke with `POSTGRES_DB=memento_eval REDIS_DB=15 node ...`.
// dotenv (loaded transitively via config.js) does NOT override already-set
// process.env, so these inline overrides win; getPrimaryPool() + redisClient
// therefore target the eval DB / eval Redis index, never the live ones.
//
// Indexes under keyId=null (namespace "_g"), matching an eval that queries
// recall() with keyId=null.

import { FragmentIndex }                       from "../lib/memory/FragmentIndex.js";
import { redisClient, connectRedis, disconnectRedis } from "../lib/redis.js";
import { getPrimaryPool }                      from "../lib/tools/db.js";

async function main() {
  if (process.env.POSTGRES_DB !== "memento_eval") {
    console.error(`[rebuild-l1] refusing to run: POSTGRES_DB="${process.env.POSTGRES_DB}" (expected memento_eval). Aborting to avoid touching the live corpus.`);
    process.exit(1);
  }

  // redisClient is created with lazyConnect:true; connectRedis() is a no-op and
  // the singleton stays in "wait" until the first command. Trigger the connect
  // explicitly, then ping to confirm readiness.
  console.log("[rebuild-l1] connecting Redis...");
  await connectRedis();
  if (redisClient.status === "wait" || redisClient.status === "end") {
    await redisClient.connect();
  }
  const pong = await redisClient.ping();
  if (pong !== "PONG") {
    console.error(`[rebuild-l1] Redis ping failed (status=${redisClient.status}). Aborting.`);
    process.exit(1);
  }
  console.log(`[rebuild-l1] Redis ready (db=${process.env.REDIS_DB ?? "default"}).`);

  const pool  = getPrimaryPool();
  const index = new FragmentIndex();
  let n = 0;

  try {
    const { rows } = await pool.query(
      `SELECT id, keywords, content, topic, type
         FROM agent_memory.fragments
        WHERE valid_to IS NULL`
    );
    console.log(`[rebuild-l1] ${rows.length} active fragments to index.`);

    for (const r of rows) {
      await index.index(
        { id: r.id, keywords: r.keywords || [], content: r.content, topic: r.topic, type: r.type },
        null,   // sessionId
        null    // keyId -> namespace "_g"
      );
      if (++n % 200 === 0) console.log(`[rebuild-l1] indexed ${n}/${rows.length}`);
    }

    console.log(`[rebuild-l1] done: ${n} fragments indexed into Redis L1 (db ${process.env.REDIS_DB ?? "default"}).`);
  } finally {
    await pool.end().catch(() => {});
    await disconnectRedis().catch(() => {});
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[rebuild-l1] fatal:", err);
  process.exit(1);
});
