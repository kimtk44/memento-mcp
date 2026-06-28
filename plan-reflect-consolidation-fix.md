# plan: reflect cross-session synthesis fix (2026-06-28)

## Problem (root cause, code-grounded)
`reflect()` auto-consolidates from a **token-keyed** Memento session that is **shared
across concurrent CC conversations** → cross-session contamination + self-duplication +
self-referential meta-summary fragments.

- `lib/tools/memory.js:74-76` injects `args.sessionId = args._sessionId` (MCP transport
  session; token-keyed per CHANGELOG L606 → concurrent conversations share one session).
- `lib/memory/ReflectProcessor.js:90` `if (params.sessionId)` → `consolidateSessionFragments`
  runs unconditionally on every reflect with a session.
- `lib/memory/SessionLinker.js:30-31` pulls `frag:sess:<sid>` set (ALL permanent frags,
  24h TTL, written by every remember) + WM list — both keyed by the shared session →
  union of every concurrent conversation's fragments.
- `lib/memory/SessionLinker.js:75-79` generates `세션 …종합:` meta-summary (violates
  reflect's own anti-meta rule) + a count-only fallback (`결정 N건…`).

Evidence: `frag-add5c004` content = "세션 **f0df338a**... 종합" = a *different* conversation's
session consolidated into this reflect. Recurrent artifacts: 05-25 (`frag-021b4174`,
param-serialization variant), 06-18 (`frag-030228b5`), 06-24 (4 frags), 06-28.
Verified: `upstream/main` did NOT touch these two files — not a duplicate of an existing fix.

## Fix (server-only, approved = Option A: opt-in consolidation)
1. **D2** — `ReflectProcessor.js:90`: gate consolidation behind opt-in `params.consolidate`
   (default false). `if (params.consolidate && params.sessionId)`.
2. **D3** — `SessionLinker.consolidateSessionFragments`: drop the `frag:sess:` permanent read;
   consolidate **working-memory only** (no re-emit of already-persisted permanent fragments).
3. **D1** — `SessionLinker`: `summary` = discrete deduped array (no `종합` wrapper);
   drop count-only fallback; `null` when no real content.
4. **Schema** — add `consolidate` boolean (default false) to `reflectDefinition`; correct the
   description (sessionId no longer auto-consolidates).

## Acceptance criteria
- AC1: `reflect({narrative_summary, sessionId})` with foreign WM in the pool → consolidation
  NOT called; output = episode only; no auto-filled summary/decisions; no `종합` fragment.
- AC2: `reflect({…, consolidate:true})` → consolidation runs, WM-only; `summary` array contains
  no `종합` wrapper string.
- AC3: existing `tests/unit/reflect-processor*.test.js` pass (consolidation test updated to
  pass `consolidate:true`).
- AC4: new regression test — default (no `consolidate`) does NOT call `consolidateSessionFragments`.

## Out of scope (flagged, separate)
- Deploy = MCP server restart (drops live Memento connection) — user-gated.
- Cleanup of existing polluted fragments (gated forget).
- wrapup usage-mitigation — deferred per user (needs verification).
- `questions:0` drop on explicit open_questions — unconfirmed, separate repro.
- repo divergence (local main ahead 12 / behind 20 vs upstream) — separate hygiene.
