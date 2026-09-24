/**
 * Reranker - Cross-Encoder 기반 검색 결과 재정렬 (듀얼 모드)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-02
 *
 * RRF 병합 이후 상위 후보를 cross-encoder로 정밀 재정렬한다.
 *
 * 모드 1 (External): RERANKER_URL 환경변수가 설정되면 외부 HTTP 서비스를 호출.
 *   - POST /rerank { query, texts[], documents[] } -> { scores[] } 또는 [{ index, score }]
 *   - TEI(text-embeddings-inference)와 { documents } -> { scores } 규격 서버 모두 지원
 *
 * 모드 2 (In-Process): RERANKER_URL 미설정 시 ONNX 모델을 프로세스 내에서 직접 실행.
 *   - @huggingface/transformers + onnxruntime-node (CPU)
 *   - 모델: Xenova/ms-marco-MiniLM-L-6-v2
 *   - ~80MB ONNX (최초 실행 시 자동 다운로드, 이후 캐싱)
 *   - cross-encoder: [query, document] 쌍으로 relevance score 출력
 */

import { RERANKER_URL, RERANKER_ENABLED, RERANKER_TIMEOUT_MS, RERANKER_MODEL, RERANKER_EXTERNAL_FALLBACK, RERANKER_EXTERNAL_COOLDOWN_MS } from "../../config.js";
import { logInfo, logWarn } from "../../logger.js";
import { byDescendingScore, normalizeCreatedAt } from "./DeterministicRanking.js";

/** ─── 공유 상태 ─── */
let _mode                      = RERANKER_URL ? "external" : "inprocess";
let _failed                    = false;
let _consecutiveExternalFails  = 0;
/** skip 정책 쿨다운 만료 시각(epoch ms). 0이면 쿨다운 없음. */
let _externalCooldownUntil     = 0;
const EXTERNAL_FAIL_THRESHOLD  = 3;
/** [fork-patch] 외부 reranker에 보내는 문서당 최대 길이. llama.cpp 컨텍스트 초과 500 방지. */
const MAX_EXTERNAL_DOC_CHARS = 6000;

/** ─── In-Process 전용 상태 ─── */
let _tokenizer = null;
let _model     = null;
let _loading   = null;

/** In-Process 모델 설정 맵 */
const MODEL_CONFIGS = {
  "minilm": { id: "Xenova/ms-marco-MiniLM-L-6-v2",          dtype: "q8" },
  "bge-m3": { id: "onnx-community/bge-reranker-v2-m3-ONNX", dtype: "q4" },
};

const _selectedModel = MODEL_CONFIGS[RERANKER_MODEL] ?? (() => {
  logWarn(`[Reranker] Unknown RERANKER_MODEL="${RERANKER_MODEL}", falling back to minilm`);
  return MODEL_CONFIGS["minilm"];
})();

/** ─── External 모드: HTTP 호출 ─── */

/** [fork-patch] */
/**
 * 문서당 문자 캡 적용 (payload-too-large 500 방지, MAX_EXTERNAL_DOC_CHARS 참조)
 * @param {string} text
 * @returns {string}
 */
function truncateForExternal(text) {
  return text.length > MAX_EXTERNAL_DOC_CHARS ? text.slice(0, MAX_EXTERNAL_DOC_CHARS) : text;
}

/** [fork-patch] sigmoid on TEI/cohere scores + failureKind classification + payload cap */
/**
 * 외부 Reranker 서비스로 재정렬 요청
 *
 * failureKind 구분:
 *   - "transport": 네트워크/타임아웃/502·503·504 — 서비스 자체가 죽었을 가능성 → service-down 카운터에 반영
 *   - "request":   4xx·500 등 서버가 응답은 했으나 이 요청을 거부(예: payload too large) — 서비스는 살아있음 → 카운터 미반영
 *
 * @param {string}   query     - 검색 쿼리
 * @param {string[]} documents - 문서 텍스트 배열
 * @returns {Promise<{scores: number[] | null, failureKind: "transport" | "request" | null}>}
 */
async function rerankExternal(query, documents) {
  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), RERANKER_TIMEOUT_MS);

    const payloadDocuments = documents.map(truncateForExternal);

    const res = await fetch(`${RERANKER_URL}/rerank`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ query, texts: payloadDocuments, documents: payloadDocuments }),
      signal:  controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        logWarn(`[Reranker] External service returned ${res.status}`);
        return { scores: null, failureKind: "transport" };
      }
      /** 4xx/500: 서비스는 살아있고 이번 요청 자체가 문제(예: payload too large) — service-down 카운터 미반영 */
      let bodyText = "";
      try { bodyText = (await res.text()).slice(0, 200); } catch (_e) { /* best-effort */ }
      logWarn(`[Reranker] External service rejected request (${res.status}, per-request failure, not counted as service-down): ${bodyText}`);
      return { scores: null, failureKind: "request" };
    }

    const data = await res.json();
    if (Array.isArray(data)) {
      if (data.length === 0) {
        logWarn("[Reranker] External service returned empty result array");
        return { scores: null, failureKind: "transport" };
      }
      const scores = new Array(documents.length).fill(0);
      for (const r of data) {
        if (Number.isInteger(r?.index) && r.index >= 0 && r.index < scores.length && typeof r.score === "number") {
          /**
           * [fork-patch] sigmoid 정규화 필수. 최종 스코어가 `sigmoidScore * recencyBoost`
           * 이므로 [0,1] 가정이 깨지면 랭킹이 무너진다. llama.cpp `--reranking`은 raw
           * logit(예: -3.17)을 주므로 그대로 쓰면 음수 * recencyBoost가 되어 최신일수록
           * 더 낮게 정렬된다. in-process 경로(sigmoid(logit))와 규약을 맞춘다.
           */
          scores[r.index] = sigmoid(r.score);
        }
      }
      return { scores, failureKind: null };
    }
    /** [fork-patch] cohere shape: {results:[{index, relevance_score(raw logit)}]} */
    if (Array.isArray(data?.results)) {
      if (data.results.length === 0) {
        /** 빈 배열은 실패로 간주 — 전부 0을 돌려주면 폴백이 안 걸리고 RRF 순서까지 뭉갠다.
         *  위 bare-array 분기와 같은 규약 (2026-08-14 redteam). */
        logWarn("[Reranker] External service returned empty results array");
        return { scores: null, failureKind: "transport" };
      }
      const scores = new Array(documents.length).fill(0);
      for (const r of data.results) {
        const idx = r.index;
        const raw = r.relevance_score ?? r.score ?? 0;
        if (Number.isInteger(idx) && idx >= 0 && idx < scores.length) scores[idx] = sigmoid(raw);
      }
      return { scores, failureKind: null };
    }
    return { scores: data.scores || null, failureKind: data.scores ? null : "transport" };
  } catch (err) {
    if (err.name === "AbortError") {
      logWarn(`[Reranker] External service timeout (${RERANKER_TIMEOUT_MS}ms)`);
    } else {
      logWarn(`[Reranker] External service error: ${err.message}`);
    }
    return { scores: null, failureKind: "transport" };
  }
}

/** ─── In-Process 모드: ONNX 직접 추론 ─── */

/**
 * 모델 + 토크나이저 싱글턴 로드
 * 최초 호출 시 ~10-20초 (다운로드 + ONNX 초기화), 이후 즉시 반환
 */
async function loadModel() {
  if (_model && _tokenizer) return { tokenizer: _tokenizer, model: _model };
  if (_failed) return null;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification } =
        await import("@huggingface/transformers");

      logInfo(`[Reranker] Loading model: ${_selectedModel.id} ...`);
      const t0 = Date.now();

      _tokenizer = await AutoTokenizer.from_pretrained(_selectedModel.id);
      _model     = await AutoModelForSequenceClassification.from_pretrained(
        _selectedModel.id,
        { dtype: _selectedModel.dtype }
      );

      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      logInfo(`[Reranker] Model ready in ${sec}s`);

      return { tokenizer: _tokenizer, model: _model };
    } catch (err) {
      logWarn(`[Reranker] Model load failed: ${err.message}`);
      _failed = true;
      return null;
    } finally {
      _loading = null;
    }
  })();

  return _loading;
}

/**
 * sigmoid 정규화
 * @param {number} x - raw logit
 * @returns {number} [0, 1]
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * In-process ONNX 추론: query-document 쌍별 relevance score
 * @param {string}   query     - 검색 쿼리
 * @param {string[]} documents - 문서 텍스트 배열
 * @returns {Promise<number[] | null>} - sigmoid 정규화된 scores
 */
async function rerankInProcess(query, documents) {
  const loaded = await loadModel();
  if (!loaded) return null;

  try {
    const { tokenizer, model } = loaded;
    const scores = [];

    for (const doc of documents) {
      const inputs = tokenizer(query, {
        text_pair:  doc,
        padding:    true,
        truncation: true
      });

      const output = await model(inputs);
      const logit  = output.logits.data[0];
      scores.push(sigmoid(logit));
    }

    return scores;
  } catch (err) {
    logWarn(`[Reranker] Inference failed: ${err.message}`);
    return null;
  }
}

/** ─── 공용 API ─── */

/**
 * Reranker 사용 가능 여부 (동기)
 *
 * External 모드: 쿨다운(skip 정책) 중이면 사용 불가로 간주한다.
 *   쿨다운 만료 후 다음 rerank() 호출이 external을 1건 재시도하며,
 *   성공 시 정상 복귀, 재실패 시 다시 쿨다운에 진입한다.
 * In-Process 모드: 모델 로드 실패(_failed)가 아니면 사용 가능.
 */
export function isRerankerAvailable() {
  if (_mode === "external") return _externalCooldownUntil <= Date.now();
  /** 인프로세스 리랭커는 명시 활성일 때만 쓴다. 기본값 근거는 config.js 주석 참조. */
  if (!RERANKER_ENABLED) return false;
  return !_failed;
}

/**
 * recency boost 계산
 *
 * 365일 기준 선형 감쇠 [0.1, 1.0] 범위
 * boost = 1 + 0.2 * (recency - 0.5)
 *
 * @param {string|Date} createdAt - 파편 생성 시각
 * @param {number} anchorTime      - 요청/cursor에 고정된 기준 시각
 * @returns {number}
 */
export function computeRecencyBoost(createdAt, anchorTime = Date.now()) {
  const parsed = createdAt ? new Date(createdAt).getTime() : NaN;
  const ts     = Number.isFinite(parsed) ? parsed : anchorTime;
  const ageDays = Math.max(0, (anchorTime - ts) / 86400000);
  const recency = Math.max(0.1, Math.min(1.0, 1.0 - (ageDays / 365) * 0.9));
  return 1 + 0.2 * (recency - 0.5);
}

/**
 * RRF 이후 후보를 cross-encoder로 재정렬
 *
 * @param {string} query      - 검색 쿼리
 * @param {Array}  candidates - [{id, content, created_at, ...}]
 * @param {number} topK       - 반환할 상위 결과 수
 * @param {number} anchorTime - recency boost 기준 시각
 * @returns {Array} [{...candidate, rerankerScore}] sorted by rerankerScore DESC
 */
export async function rerank(query, candidates, topK = 15, anchorTime = Date.now()) {
  if (!candidates || candidates.length === 0) return [];

  /** 쿨다운 중이면 external HTTP 호출을 생략하고 원순서 그대로 반환(fail-fast) */
  if (_mode === "external" && _externalCooldownUntil > Date.now()) {
    return candidates;
  }

  /** Hindsight 패턴: content에 날짜 프리픽스 추가 */
  const documents = candidates.map(c => {
    const timestamp = normalizeCreatedAt(c.created_at);
    const dateStr = timestamp === null
      ? "unknown"
      : new Date(timestamp).toISOString().slice(0, 10);
    return `[Date: ${dateStr}] ${c.content || ""}`;
  });

  /** 모드별 점수 산출 */
  /** [fork-patch] external은 {scores, failureKind}를 돌려준다. "request"(4xx/500 = 이 요청만의
   *  문제, 예: 과대 payload)는 서비스 장애가 아니므로 연속 실패 streak에 세지 않는다 —
   *  세면 요청 하나가 모든 질의의 리랭킹을 쿨다운에 가둔다. */
  let scores;
  let failureKind = null;
  if (_mode === "external") {
    ({ scores, failureKind } = await rerankExternal(query, documents));
  } else {
    scores = await rerankInProcess(query, documents);
  }

  /** 서비스 불가 시 graceful degradation: 원본 그대로 반환 */
  if (!scores) {
    if (_mode === "external" && failureKind === "request") return candidates;
    if (_mode === "external") {
      _consecutiveExternalFails++;
      if (_consecutiveExternalFails >= EXTERNAL_FAIL_THRESHOLD) {
        if (RERANKER_EXTERNAL_FALLBACK === "inprocess") {
          logWarn("[Reranker] External service unavailable (3 consecutive failures), switching to in-process mode");
          _mode = "inprocess";
          _consecutiveExternalFails = 0;
          loadModel().catch(() => {});
        } else {
          /** 기본: in-process 전환 없이 쿨다운 진입 — 창 동안 external 호출을 생략하여 CPU/스레드 병목 전이 차단 */
          _externalCooldownUntil = Date.now() + RERANKER_EXTERNAL_COOLDOWN_MS;
          logWarn(`[Reranker] External service unavailable (3 consecutive failures), entering cooldown for ${RERANKER_EXTERNAL_COOLDOWN_MS}ms (original scores retained)`);
        }
      }
    }
    return candidates;
  }

  /** external 성공: 실패 카운터·쿨다운 해제 */
  if (_mode === "external") {
    _consecutiveExternalFails = 0;
    _externalCooldownUntil    = 0;
  }

  /** 최종 스코어: sigmoidScore * recencyBoost */
  return applyRerankerScores(candidates, scores, anchorTime).slice(0, topK);
}

/** 고정 anchorTime으로 raw reranker score에 recency boost를 적용하고 결정 정렬한다. */
export function applyRerankerScores(candidates, scores, anchorTime = Date.now()) {
  /** 불완전하거나 비유한 응답에 NaN score를 붙이지 않는다. 일부 후보만
   *  다른 score 체계를 쓰는 것보다 전체를 기존 랭킹으로 폴백하는 편이 안전하다. */
  if (!Array.isArray(scores) || scores.length !== candidates.length ||
      scores.some(score => !Number.isFinite(score))) {
    return candidates;
  }

  const scored = candidates.map((candidate, index) => ({
    ...candidate,
    rerankerScore: scores[index] * computeRecencyBoost(candidate.created_at, anchorTime)
  }));
  return scored.sort(byDescendingScore(candidate => candidate.rerankerScore));
}

/**
 * Reranker 사전 로드 (서버 시작 시 호출)
 * External 모드: 헬스체크, In-Process 모드: 모델 로드
 */
export async function preloadReranker() {
  if (_mode === "external") {
    try {
      const res = await fetch(`${RERANKER_URL}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) throw new Error(`health ${res.status}`);
      let _rrmodel = "unknown";
      try { const data = await res.json(); _rrmodel = data.model || "unknown"; } catch (_e) { /* TEI /health returns empty body */ }
      logInfo(`[Reranker] External mode: ${RERANKER_URL} (model: ${_rrmodel})`);
    } catch (err) {
      /** [fork-patch] skip 정책에서는 기동 시 health 실패로 inprocess에 고정하지 않는다.
       *  RERANKER_ENABLED=false면 inprocess 모드의 isRerankerAvailable()이 영구 false라
       *  재시작 전까지 리랭킹이 무음으로 꺼진다. external을 유지하면 런타임 실패는
       *  rerank()의 streak→쿨다운 경로가 처리하고, 서비스가 돌아오면 바로 복구된다. */
      if (RERANKER_EXTERNAL_FALLBACK !== "inprocess") {
        logWarn(`[Reranker] External service health check failed: ${err.message}; staying in external mode (fallback=${RERANKER_EXTERNAL_FALLBACK})`);
        return;
      }
      logWarn(`[Reranker] External service health check failed: ${err.message}, falling back to in-process`);
      _mode = "inprocess";
      if (!RERANKER_ENABLED) return;
      await loadModel();
    }
    return;
  }

  if (!RERANKER_ENABLED) {
    logInfo("[Reranker] In-process 리랭커가 비활성이라 모델을 적재하지 않습니다 (MEMENTO_RERANKER_ENABLED=true로 활성)");
    return;
  }

  logInfo(`[Reranker] In-process mode: loading ONNX model (${_selectedModel.id}, dtype=${_selectedModel.dtype})...`);
  await loadModel();
}
