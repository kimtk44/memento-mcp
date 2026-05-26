# CLAUDE.md — memento-mcp

> Local-patched fork. Upstream remote = `JinHo-von-Choi/memento-mcp.git`, push 권한 없음 (사용자 kimtk44 GitHub 인증, JinHo-von-Choi 계정 별도). 본 install은 운영 서버(localhost:57332) ground truth — 본인 서버는 본 directory의 local commit으로 작동.

## 2026-05-19 local-only amend handler patch — CRITICAL

`amend` 호출 시 `workspace` 파라미터 silent no-op bug (Pending L431, 2026-04-29 발견) fix.

**적용 patch (commit `d7e5a31`, local main, NOT pushed)**:

- `lib/memory/MemoryManager.js` — amend handler updates 객체에 `workspace` 박음 (1줄)
- `lib/tools/memory-schemas.js` — MCP tool schema `amendDefinition` properties에 `workspace` 추가 (5줄)
- `lib/memory/FragmentWriter.js` — store.update SELECT 구문 `workspace` 컬럼 추가 + setClauses 블록 추가 (5줄 + 1 컬럼)

**Verify (2026-05-19)**: server schema curl tools/list 결과 `workspace` property present. amend({id, workspace: "..."}) 호출 success + DB UPDATE 적용 (search_traces(workspace="memento-mcp") 결과 갱신 fragment 포함 확인, frag-5b763c7c1daa1468).

## 2026-05-26 local-only recall trim patch

`recall` text/semantic 경로가 0건 회귀하던 버그 fix.

**적용 patch (commit `90b1270`, local main, NOT pushed)**:

- `lib/memory/FragmentSearch.js` — `_trimToTokenBudget()`가 최상위 파편 토큰비용 > `tokenBudget`일 때 `break`로 결과 전체를 폐기(빈 배열 반환) → recall 0건. result가 비면 `fragments[0]` 1건을 넣어 **최소 1건 보장** (주석 포함 ~5줄).

**원인**: 한국어 text recall에서 cross-encoder(영어 MiniLM)가 후보를 재정렬해 큰 파편이 rank #1에 오고, 호출 측이 작은 `tokenBudget`을 쓰면 head 단독 starvation으로 전체 0건. (DB `search_events` event 1357 = result_count 0, l3_count 30 실측.)

**Verify (2026-05-26)**: restart 후 `recall(text=…, tokenBudget=100)` 0건→1건 / 기본 budget 15건 gold(frag-b643da10) #1 무회귀 (search_events 1386/1387).

> 참고: `07b9081` (embedding fail-fast OpenAI client) 도 동일하게 local-only 미push commit. 본 commit stack(`d7e5a31` → `07b9081` → `90b1270`) 전체가 아래 NEVER 가드 보호 대상.

## 2026-05-26 local-only reranker GPU external patch

한국어 재정렬 품질 + 지연 동시 해결 위해 reranker를 영어 MiniLM(in-process) → bge-reranker-v2-m3(GPU external)로 전환.

**적용 patch (commit `602ba7e`, local main, NOT pushed)**:

- `lib/memory/Reranker.js` — `rerankExternal()`가 llama.cpp `--reranking` / Jina 응답 포맷 `{results:[{index, relevance_score}]}`(raw logit)을 파싱: `index`로 원본 document 순서 재매핑 + `sigmoid`로 [0,1] 정규화(in-process 경로와 스케일 일치). `data.scores` 폴백 유지.
- (관련) `4fcb43b` — opt-in `rankingMode`(recency-off, 오래된 파편 recall용) 도 같은 트랙 local-only commit.

**왜 필수**: 미패치 시 `rerankExternal`이 `data.scores`(undefined)만 읽어 `null` 반환 → external 3연속 실패 → 느린 in-process ONNX(CPU)로 **silent fallback**. 즉 GPU 서버를 띄워도 코드 패치 없으면 external이 절대 안 쓰임.

**.env (gitignore, machine-config — 비휴대)**: `RERANKER_URL=http://localhost:8083`(llama.cpp `--reranking` bge-reranker-v2-m3, MERC GPU), `RERANKER_MODEL=bge-m3`(external 실패 시 in-process ONNX fallback 모델), `RERANKER_TIMEOUT_MS=8000`.

**운영 의존**: `:8083` reranker 서버가 떠 있어야 external 사용. 다운 시 in-process bge-m3 ONNX(CPU q4 ~2.5–8s)로 fallback — 동작하나 느림.

**Verify (2026-05-26)**: restart 후 로그 `[Reranker] External mode: http://localhost:8083`(in-process 로드 없음). recall latency **424–755ms** (in-process bge-m3 ~8000ms / 영어 MiniLM ~961ms 대비), gold(frag-b643da10) #1 품질 유지 (search_events 1455/1456).

## 2026-05-26 local-only search_events query_text + SKILL.md rankingMode patch

followup #10/#4 (출처 vault `00 Inbox/2026-05-26_memento-retrieval-followups.md`).

**적용 patch (commit `9236587`, local main, NOT pushed)**:

- `lib/memory/migration-032-search-events-query-text.sql` (신규) — `search_events.query_text TEXT` 추가 (additive, IF NOT EXISTS, 무손실). **운영 DB(127.0.0.1:5432/memento)에 이미 적용됨** — `git pull --rebase`로 코드만 되돌려도 DB 컬럼은 잔류(IF NOT EXISTS라 재적용 안전).
- `lib/memory/SearchEventRecorder.js` — `serializeQueryText()` 헬퍼 + `buildSearchEvent` query_text 필드 + `recordSearchEvent` INSERT `$17`. (#10: query_type/filter_keys만으로 "무엇을 검색했는지" 복원 불가 → text/keywords/topic 원본 JSON 보존.)
- `SKILL.md` — #4 rankingMode 발견성: 검색 의사결정 트리 + 세션 생명주기 recall 표에 `rankingMode="semantic"` 안내 (get_skill_guide 노출). doc-only.

**Verify (2026-05-26)**: jest unit 125 pass. restart 후 라이브 recall search_event 1463 query_text 정상 기록 (`{"text":…,"keywords":[…],"topic":"memento-mcp"}`). get_skill_guide(section=search) rankingMode 팁 서빙 확인.

> 동시 운영: `5c88d24` (LLM Server Agent <agent@llm-server.local>, 11:25:38) = 위 reranker § docs 기록 커밋. 본 repo는 동시 자동화 에이전트가 docs 커밋을 추가할 수 있음 — 본 § 중복 docs 커밋 발견 시 머지.

## 2026-05-26 local-only amend re-embed enqueue patch (#5 fix)

followup #5 검증 결과 fix. amend가 content를 바꾸면 `embedding=NULL`이 되는데, remember와 달리 임베딩 큐에 enqueue하지 않아 재임베딩이 orphan 스캔(scheduler 30분 / consolidator 1시간)에만 의존 → amend 직후 ~최대 30분 L3 semantic recall 누락.

**적용 patch (commit `fc67fde`, local main, NOT pushed)**:

- `lib/memory/MemoryManager.js` — import `pushToQueue` + `amend`에서 `updates.content !== undefined`일 때 `pushToQueue(MEMORY_CONFIG.embeddingWorker.queueKey, {fragmentId})` 추가 (re-index 직후). remember와 동일 경로 → ~1–5초 재임베딩. Redis 다운 시 false 반환 → 기존 orphan 스캔 폴백.

**왜 stale 아님**: amend는 항상 새 content로 재임베딩(`processOrphanFragments`/큐 워커 `_embedOne`이 `SELECT content` = 현재 content). 문제는 데이터 stale이 아니라 **재인덱스 latency**였음. 라이브 검증: amend 후 B(새)쿼리 sim 0.66 rank 1 / A(옛)쿼리 absent = fresh.

**amend 인접 코드 주의 (NEVER guard #3 정합)**: 본 patch는 `MemoryManager.amend` handler에 enqueue만 **추가** — d7e5a31 workspace 처리부 무변경. 검증: workspace=sandbox amend 정상 적용 확인.

**Verify (2026-05-26)**: jest unit 125 pass. restart 후 amend→재임베딩 ~1초(fix 전 40초+ NULL). throwaway 파편 정리 완료.

## 다른 세션 위험 — NEVER 위반

- **NEVER `git pull --rebase`** or **`git reset --hard origin/main`** — local commit stack `d7e5a31` → `07b9081` → `90b1270` → `4fcb43b` → `602ba7e` → `9236587` → `fc67fde` 잃음 (push 차단됨, local만 존재)
- **NEVER re-patch** — 이미 박혀 있음. `amend workspace` bug 다시 발견하면 본 doc § 2026-05-19 read 의무
- **다른 amend 관련 코드 수정 시 본 patch 인지 필수** — `MemoryManager.amend` (handler), `FragmentWriter.update` (store SQL), `memory-schemas.amendDefinition` (tool schema) 모두 patched
- 본 patch 변경 시 `sudo systemctl restart memento-mcp` 후 amend test 의무 (search_traces(workspace=...) verify)

## upstream sync 트랙 (사용자 결정 영역)

push 차단 = 코드 공유 불가. 본인 서버 운영은 local만으로 작동. 옵션:

- (a) JinHo-von-Choi 계정 본인 보유 시 그 계정 인증 후 push
- (b) `kimtk44/memento-mcp` 본인 fork 신설 + remote 변경 + push
- (c) upstream (또는 본 fork의 upstream)에 issue 또는 PR 작성

사용자 GitHub 작성 후속 트랙: vault inbox todo `00 Inbox/2026-05-19_memento-amend-patch-github-action.md` 참조 (별 vault doc과 link).

## 다른 잔존 변경 (별 작업, 본 amend 무관)

- `package-lock.json` M: version `2.2.1 → 2.7.0` (server v2.7.0 정합, 다른 작업으로 변경)
- `start.sh` untracked: 본인 운영 launcher (`cd + .env load + node server.js`), git track 결정 영역

## Memento anchors

- `frag-f9365828e09f6fbc` — 본 patch decision anchor (workspace=memento-mcp, isAnchor=true, importance=0.9, verified). content: local patch + restart 의무 + push 차단 + 다른 세션 위험 (NEVER 위반 4건).
- `frag-d7e5a31` 잠정 reference (실제 git commit hash, Memento에 박는 fragment 별도)

## 처분 (작업 완료 후) — NEVER 위반 해제 trigger

upstream sync 옵션 (a)/(b)/(c) 중 1건 완료 시 본 § 2026-05-19 (CRITICAL) 정리 절차:

### 작업 완료 trigger

- **옵션 (a) JinHo-von-Choi 본인 인증 push 완료**: 본 fork main에 amend patch 박힘 → 다른 세션 `git pull` 안전
- **옵션 (b) kimtk44/memento-mcp fork 신설 + remote 변경 + push 완료**: 동일 효과 (remote 변경 명령 = `git remote set-url origin <new-fork-url>`)
- **옵션 (c) upstream issue/PR merge 완료**: upstream에 patch → fork `git pull --rebase` 시 conflict 가능 (신중, local commit d7e5a31과 upstream commit 중복 가능)

verify 명령 (1건 완료 후):
```
cd ~/workspace/dev/memento-mcp
git log origin/main --grep="amend handler workspace" | head -5
# 결과에 patch commit 보이면 trigger 충족
```

### 3축 정리 절차 (trigger 충족 후)

1. **본 § "2026-05-19 local-only amend handler patch — CRITICAL" 정리**:
   - § 제목 변경: `## 2026-05-19 amend handler patch — RESOLVED YYYY-MM-DD (옵션 X)`
   - § 본문 끝에 추가: `> 작업 완료 YYYY-MM-DD: 옵션 X 처리 완료. 본 § 이후 historical record only — NEVER 위반 4건 해제됨.`
   - 또는 본 § 통째로 `## Historical Records` 새 § 안으로 이동

2. **본 § "다른 세션 위험 — NEVER 위반" 해제**:
   - § 제목 변경: `## ~~다른 세션 위험 — NEVER 위반~~ (RESOLVED YYYY-MM-DD)`
   - 본문 4건 위반에 ~~strikethrough~~ 적용 + caveat: `> 옵션 X 처리 완료로 NEVER 위반 4건 해제. git pull/rebase 안전.`

3. **Memento decision anchor `frag-f9365828e09f6fbc` amend**:
   ```
   mcp__memento__amend({
     id: "frag-f9365828e09f6fbc",
     assertionStatus: "rejected",
     importance: 0.3,
     content: "resolved YYYY-MM-DD via 옵션 X — local patch가 upstream/fork에 박혀 다른 세션 안전. NEVER 위반 4건 해제."
   })
   ```

4. **vault inbox todo `00 Inbox/2026-05-19_memento-amend-patch-github-action.md` frontmatter 갱신**:
   - `status: pending-user-action` → `status: resolved`
   - `resolved_at: YYYY-MM-DD` 박음
   - `resolved_by: "옵션 X — <상세>"` 박음
   - §7 변경 이력 entry 추가
   - 본문 archive 안 함 (vault preservation 정합 — autonomous archive X)

### 정리 후 verify

- `git pull --rebase origin main` 안전 실행 가능 (NEVER 1번 해제)
- 다른 세션 `cd ~/workspace/dev/memento-mcp` 진입 시 본 CLAUDE.md RESOLVED 마킹 read → re-patch 시도 없음 (NEVER 2번 해제)
- amend 관련 코드 자유 수정 가능 (NEVER 3번 해제)

### Memento procedure anchor

`frag-` cleanup-procedure-when-resolved (workspace=memento-mcp, isAnchor=true, importance=0.85) — 본 절차 cross-search 박힘.

## Workflow inherit

본 directory는 `~/workspace/dev/CLAUDE.md` (Coding Workspace, R→P→I + Grounding Rule + Verification) 상속. 추가 룰만 본 doc.
