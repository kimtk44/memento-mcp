# 테스트 가이드

작성자: 최진호
작성일: 2026-04-29

---

## 개요

memento-mcp의 테스트는 세 계층으로 구성된다.

- 단위 테스트 (Jest + node:test): 외부 의존성 없이 모듈 단위 검증
- 통합 테스트: DB/Redis 연결 가능 여부를 런타임 자동 판단 또는 환경변수 활성화
- E2E 테스트: 실행 중인 서버와 실제 LLM CLI를 대상으로 하는 전단 검증

---

## 단위 테스트 실행

```bash
# 전체 단위 테스트 (Jest + node:test 통합)
npm test

# Jest 단위 테스트만
npm run test:jest

# node:test 단위 테스트만
npm run test:unit:node

# 직접 실행 (MEMENTO_METRICS_DEFAULT=off 권장)
MEMENTO_METRICS_DEFAULT=off node --experimental-test-module-mocks --test \
  'tests/unit/*.test.js' \
  'tests/unit/**/*.test.js'
```

`MEMENTO_METRICS_DEFAULT=off`는 prom-client 레지스트리 중복 초기화 경고를 억제한다.
단위 테스트는 DB, Redis, EMBEDDING_API_KEY 없이 실행된다.

---

## 통합 테스트 실행

```bash
# 전체 통합 테스트 + E2E (glob)
npm run test:integration

# LLM E2E만 순차 실행
npm run test:integration:llm
```

통합 테스트 상세 실행 방법과 환경변수 가드는
[tests/integration/README.md](../tests/integration/README.md)를 참조한다.

---

## npm 스크립트 요약

| 스크립트 | 실행 범위 |
|--------|---------|
| `npm test` | unit 전체 (Jest + node:test) |
| `npm run test:jest` | Jest unit 테스트만 |
| `npm run test:unit:node` | node:test unit 테스트만 |
| `npm run test:integration` | 통합 + e2e (tests/integration/*.test.js + tests/e2e/*.test.js) |
| `npm run test:e2e` | e2e만 |
| `npm run test:ci` | `npm test && npm run test:integration` — CI 단일 게이트 (DB/Redis 필요) |
| `npm run lint:migrations` | migration SQL body-only 규약 검사 (MIGRATION_LINT_FROM 기준) |

---

## 테스트 파일 목록

### 단위 테스트 (tests/unit/)

| 파일 | 검증 내용 |
|---|---|
| `embedding-worker-batch.test.js` | EmbeddingWorker._embedMany 배치화 4 시나리오 (정상/빈content/HTTP400/인덱스오류) |
| `morpheme-batch.test.js` | MorphemeIndex 배치 임베딩 + multi-row INSERT, 순서 보존, HTTP 400 격리 재시도 |
| `consistency-gate.test.js` | Consistency Gate SQL 조건 생성 검증 (morpheme_indexed, morphemeOnly, keyId 조합) |
| `session-linker-batch.test.js` | SessionLinker createLinks 배치 호출, sortedKey 오름차순, cycle 격리, fallback |

### 통합 테스트 (tests/integration/)

| 파일 | 전제 조건 |
|---|---|
| `db-pool-isolation.test.js` | DB 없는 환경: Pool 구조 케이스 실행, application_name SELECT skip |
| `session-linker-deadlock.test.js` | DATABASE_URL 필수. 미설정 시 전체 skip |
| `reflect-large-payload.test.js` | DB/Redis/API키 불필요. 항상 실행 가능 |

`reflect-large-payload.test.js`와 `embedding-worker-batch.test.js`는 모든 의존성을
stub으로 격리하므로 `npm test`(단위 테스트 runner)로도 실행 가능하다.

---

## 알려진 결함

아래 3건은 LLM provider CLI 통합 계층의 기존 결함이다. 메모리 코어 로직과 무관하다.
CI에서 전체 통과 수를 비교할 때 이 3건을 기준에서 제외하여 판단한다.

| 테스트 | 원인 | 상태 |
|---|---|---|
| codex-cli provider SyntaxError | codex-cli 외부 바이너리 파싱 결함 | upstream 이슈 |
| qwen-cli provider SyntaxError | qwen-cli 외부 바이너리 파싱 결함 | upstream 이슈 |
| llm-provider-cooldown timeout | 의도된 타임아웃 동작 검증 케이스 | 의도적 설계, 수정 불필요 |

---

## 전체 테스트 현황

- 단위 테스트: 1779/1784 PASS (실패 5건 = 위 기존 결함 3건 + 관련 2건)
- 통합 테스트: DB/Redis 환경에서 전체 통과
- E2E: LLM CLI 인증 환경에서 전체 통과
