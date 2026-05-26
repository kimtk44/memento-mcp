# plan.md — Track B: L3 recall recency-skew 수정

작성 2026-05-26 · status: **옵션1 구현+라이브 검증 완료 (2026-05-26)** · R→P→I · 미커밋(사용자 결정, push는 fork라 차단)

## 라이브 검증 결과 (2026-05-26, restart 후 PID 1504835)

옛 probe 5개 `recall(rankingMode:"semantic")` → 정답 top-3 전원 진입 (4개 rank 1, 1개 rank 3+sibling rank 1). 최신 probe rank 1 유지(회귀 0). balanced(기본)은 옛 정답 여전히 ABSENT(=동작 불변). unit 23/23 pass. 라이브 MCP: CTS 정답(40일, sim 0.587) **rank 1**, searchPath `L2:0 → L3:29 → RRF`(Rerank 없음 = semantic 우회 확인).

### 구현 중 수정한 핵심 (1차 가설 정정)
- **1차 오류**: semantic = rerankerScore 우선 → 실패. `ms-marco-MiniLM`(영어 cross-encoder)이 한국어에서 ~uniform(1.08)이라 무변별 + 30→15 컷이 high-sim 옛 파편 누락.
- **정정**: semantic = **raw L3 similarity** 기준 정렬 + **semantic 모드에선 reranker 우회**(RRF=L3 cosine 순서 유지). importance 0.001 tiebreak만.
- 최종 편집 4파일 영역: memory-schemas(param) / MemoryManager(전달+최종 sort similarity 분기) / FragmentSearch(_deduplicate similarity 분기 + rerank 우회 분기). 전부 semantic 게이트, default byte-identical.



## 구현 결과 (2026-05-26, 옵션 1, restart 전)

5개 편집 (default 경로 byte-identical, 전부 `rankingMode==="semantic"` 분기):
1. `lib/tools/memory-schemas.js` recallDefinition — `rankingMode` enum(balanced|semantic) 파라미터 추가.
2. `lib/memory/MemoryManager.js` recall — search.search() 에 `rankingMode` 전달.
3. `lib/memory/MemoryManager.js` 최종 sort(L426) — semantic 분기: `rerankerScore ?? (importance*0.1 + similarity*0.9)`, recency 0.
4. `lib/memory/FragmentSearch.js` `_deduplicate` 호출 — `sq.rankingMode` 전달.
5. `lib/memory/FragmentSearch.js` `_deduplicate` scoreOf — semantic fallback(리랭커 미가용/키워드 검색).

검증(restart 전): `node --check` 3파일 OK · `git diff --stat` = 본 3파일만 · amend handler 무변경 · unit test 23/23 pass(temporal-ranking 포함, default 동작 불변).

### 남은 단계 (사용자 타이밍)
- **`sudo systemctl restart memento-mcp`** (사용자 실행 영역) — 후 MCP 스키마에 rankingMode 노출.
- restart 후 verify: 옛 probe 5개 `recall(text, rankingMode:"semantic")` → 정답 top-5 기대 (현재 absent/rank-14). 최신 probe 회귀 없음. 기본 recall() diff 0.
- 미커밋 (사용자 결정). 커밋 시 메시지 영어 + amend patch(d7e5a31) 인지.

---
(이하 원안)


## 문제 (증거 기반)

recall 이 의미적으로 정확한 **옛 fragment 를 최하위로 매몰**시킨다.
- 진단(bge-vs-qwen 세션): 옛(4월) probe 5개에서 flat-cosine bge-m3 는 정답을 rank 1~3 에 올리나, live recall 의 top 결과엔 0/5.
- 결정적 trace: query "3D 프린터 기종/가격" → 정답 `frag-ed007934` (sim **0.643, 결과 15건 중 최고 유사도**)가 **rank 14/15**. 그 위 13건은 전부 최신(age 0~3d) + 더 낮은 유사도(0.39~0.47).
- 즉 retrieval miss 아님(HNSW+RRF+rerank 가 후보로 잡음). **최종 정렬이 recency 가중으로 강등.**
- 임베더 무관: Qwen 도 동일 유사도(rank 1) → 교체로 안 고쳐짐. (bge-vs-qwen REPORT 참조: `~/workspace/dev/model-bench-round2/embed-ko/`)

## 근본 원인 (정확한 locus)

`lib/memory/MemoryManager.js:426-439` — FragmentSearch(rerank 포함) 반환 후 적용되는 **최종 복합 재정렬**:
```
score = importance*0.4 + proximity*0.3 + similarity*0.3   (proximity = 2^(-ageDays/30))
```
- `config/memory.js`: importanceWeight 0.4 / recencyWeight 0.3 / semanticWeight 0.3 / recencyHalfLifeDays 30.
- 두 문제:
  1. **semantic 이 점수의 30% 뿐** → 40일 fragment proximity=0.40, 당일=1.0. 0.30 차이가 sim 0.643 vs 0.42 (0.22 차이의 0.3배=0.066)를 뒤집음. 계산: ed007934 ≈ 0.55 vs 최신 Max-plan ≈ 0.70.
  2. **rerankerScore 폐기**: line 433 `f.similarity` 사용 → L4 cross-encoder(`combined.slice(0,30)` → rerank 15) 의 정밀 정렬이 이 최종 sort 로 덮어써짐. rerank 가 사실상 무력화.
- 부차 기여(확인됨, 수정 1차 범위 아님): `decay.js` importance 시간 감쇠 / 항상 켜진 Temporal RRF 레이어(FragmentSearch.js:247) / emaBoost.

## 제안 수정 (최소·opt-in 우선)

### 옵션 1 (권장, 저위험): recall 에 `rankingMode` 파라미터 추가
- `"balanced"`(기본=현행 동작 불변) / `"semantic"`(recency-off).
- thread: `lib/tools/memory-schemas.js` recallDefinition(L180) properties 에 `rankingMode` 추가 → `MemoryManager.recall` 인자 → L425-436 sort 가중치 분기.
- `"semantic"` 시: importance 0.1 / recency 0.0 / semantic 0.9, 그리고 **rerankerScore 있으면 그걸 우선** (`f.rerankerScore ?? composite`).
- 기본 동작(메모리다운 recency 선호)은 그대로 보존 → 사실/옛정보 회상만 opt-in 으로 순수 의미 정렬.

### 옵션 2 (default 개선, 별도 승인 필요): 최종 sort 가 rerankerScore 존중
- L426-439 에서 rerankerScore 존재 시 그것을 1차 키로. (L4 rerank 무력화 latent bug 해소.) 모든 recall 영향 → 신중.

### 옵션 3 (튜닝만): recencyHalfLifeDays 30→90/180 또는 semanticWeight 상향
- 한 줄 config. 전역 영향, 효과 부분적.

## NEVER 룰 / 주의 (memento-mcp fork)

- `MemoryManager.js` 는 **amend patch(commit d7e5a31) 보유 파일** — 본 수정은 `recall` 정렬부(L425-439)로 `amend` handler 와 무관. **amend 코드 절대 안 건드림.**
- **NEVER git pull --rebase / reset --hard** (local commit 유실).
- 수정 후 **`sudo systemctl restart memento-mcp` 의무** (사용자 실행 영역) + verify.

## 수용 기준 (구현 후 검증)

1. restart 후 옛 probe 5개 `recall(rankingMode:"semantic")` → 정답 fragment **top-5 진입** (현재 absent/rank-14).
2. 최신 probe 6개 회귀 없음 (여전히 top-3).
3. `rankingMode` 미지정 시 기존 결과와 동일(기본 동작 불변) — diff 0 회귀 테스트.
4. `tests/unit/temporal-ranking.test.js` 통과.

## 결정 게이트

**구현 전 사용자 승인 필요**: (a) 옵션 1만(opt-in, 안전) / (b) 옵션1+2(default 도 rerank 존중) / (c) 옵션 3 튜닝 / 범위 확정 후 implement.
