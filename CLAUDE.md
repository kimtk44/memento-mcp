# CLAUDE.md — memento-mcp

> Local-patched fork. Upstream remote = `JinHo-von-Choi/memento-mcp.git`, push 권한 없음 (사용자 kimtk44 GitHub 인증, JinHo-von-Choi 계정 별도). 본 install은 운영 서버(localhost:57332) ground truth — 본인 서버는 본 directory의 local commit으로 작동.

## 2026-05-19 local-only amend handler patch — CRITICAL

`amend` 호출 시 `workspace` 파라미터 silent no-op bug (Pending L431, 2026-04-29 발견) fix.

**적용 patch (commit `d7e5a31`, local main, NOT pushed)**:

- `lib/memory/MemoryManager.js` — amend handler updates 객체에 `workspace` 박음 (1줄)
- `lib/tools/memory-schemas.js` — MCP tool schema `amendDefinition` properties에 `workspace` 추가 (5줄)
- `lib/memory/FragmentWriter.js` — store.update SELECT 구문 `workspace` 컬럼 추가 + setClauses 블록 추가 (5줄 + 1 컬럼)

**Verify (2026-05-19)**: server schema curl tools/list 결과 `workspace` property present. amend({id, workspace: "..."}) 호출 success + DB UPDATE 적용 (search_traces(workspace="memento-mcp") 결과 갱신 fragment 포함 확인, frag-5b763c7c1daa1468).

## 다른 세션 위험 — NEVER 위반

- **NEVER `git pull --rebase`** or **`git reset --hard origin/main`** — local commit `d7e5a31` 잃음 (push 차단됨, local만 존재)
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

## Workflow inherit

본 directory는 `~/workspace/dev/CLAUDE.md` (Coding Workspace, R→P→I + Grounding Rule + Verification) 상속. 추가 룰만 본 doc.
