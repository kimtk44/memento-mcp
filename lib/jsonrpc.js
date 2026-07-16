/**
 * JSON-RPC 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION } from "./config.js";
import { SymbolicPolicyViolationError } from "./symbolic/errors.js";
import { filterTools } from "./memory/ModeRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve(path.dirname(__filename), "..", "package.json"), "utf8")).version;
import { getToolsDefinition } from "./tools/index.js";
import { TOOL_REGISTRY }     from "./tool-registry.js";
import { PROMPTS, getPrompt as getPromptContent } from "./tools/prompts.js";
import { RESOURCES, readResource as readResourceContent } from "./tools/resources.js";
import {
  recordRpcMethod,
  recordToolExecution,
  recordProtocolNegotiation,
  recordError,
  recordRbacDenied
} from "./metrics.js";
import { logInfo, logError } from "./logger.js";
import { checkPermission }   from "./rbac.js";

/**
 * JSON-RPC 에러 응답 생성
 */
export function jsonRpcError(id, code, message, data) {
  const err                = { code, message };

  if (data !== undefined) {
    err.data             = data;
  }

  return {
    jsonrpc: "2.0",
    id,
    error : err
  };
}

/**
 * JSON-RPC 성공 응답 생성
 */
export function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

/**
 * 프로토콜 버전 협상
 * 클라이언트가 요청한 버전과 서버가 지원하는 버전을 비교하여 최적 버전 선택
 *
 * @param {string|undefined} clientVersion - 클라이언트가 요청한 프로토콜 버전
 * @returns {string} - 협상된 프로토콜 버전
 */
function negotiateProtocolVersion(clientVersion) {
  if (!clientVersion) {
    logInfo(`[Protocol] Client did not specify version, using default: ${DEFAULT_PROTOCOL_VERSION}`);
    return DEFAULT_PROTOCOL_VERSION;
  }

  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) {
    logInfo(`[Protocol] Client requested ${clientVersion}, supported - using requested version`);
    return clientVersion;
  }

  /** 서버 최신 버전 이하의 날짜 기반 버전이면 호환성 수용 */
  const latestVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
  try {
    const clientDate = new Date(clientVersion);
    const latestDate = new Date(latestVersion);
    if (!isNaN(clientDate.getTime()) && !isNaN(latestDate.getTime()) && clientDate <= latestDate) {
      logInfo(`[Protocol] Client requested ${clientVersion}, which is <= server latest (${latestVersion}) - accepting for forward compatibility`);
      return clientVersion;
    }
  } catch {
    /* 날짜 파싱 실패 시 폴백 로직 수행 */
  }

  /** 날짜 기반 가장 가까운 하위 버전 선택 */
  const clientDate       = new Date(clientVersion);
  let fallbackVersion    = null;

  for (const supportedVersion of SUPPORTED_PROTOCOL_VERSIONS) {
    const supportedDate  = new Date(supportedVersion);
    if (supportedDate <= clientDate) {
      fallbackVersion    = supportedVersion;
      break;
    }
  }

  if (!fallbackVersion) {
    fallbackVersion      = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
    logInfo(`[Protocol] Client requested ${clientVersion}, older than all supported - using oldest: ${fallbackVersion}`);
  } else {
    logInfo(`[Protocol] Client requested ${clientVersion}, not explicitly in supported list - falling back to ${fallbackVersion}`);
  }

  return fallbackVersion;
}

/**
 * README.md 읽기 (환영 메시지용)
 */
/**
 * initialize 핸들러
 */
export async function handleInitialize(params) {
  const startTime        = process.hrtime.bigint();

  try {
    // 클라이언트가 요청한 프로토콜 버전 확인
    const clientVersion      = params?.protocolVersion;
    const negotiatedVersion  = negotiateProtocolVersion(clientVersion);

    // 프로토콜 버전 협상 메트릭 기록
    recordProtocolNegotiation(clientVersion, negotiatedVersion);

    const aiInstructions     = `# Memento MCP Server

연결 성공. Fragment-Based Memory 시스템.

## 세션 시작 (필수)

context 도구를 즉시 호출한다 (structured=true). 생략 시 과거 세션에서 축적된 사용자 맥락을 잃는다.
응답에 _meta.hints[0] / _meta.suggestion이 있으면 해당 trigger 도구를 고려한다.

## 능동 트리거 (요지)

- "에러/실패" 발화 → recall(type="error") 먼저; 원인 확정 시 remember(type="error", 0.8); 해결 시 amend(resolutionStatus="resolved") 또는 forget + remember(type="procedure")
- 설정/포트/경로/버전 변경 전 → recall 먼저
- 아키텍처/기술 선택 확정 → remember(type="decision", 0.7)
- "이전에/저번에" 언급 → recall
- 세션 종료 → reflect (원자적 파편 개별 저장; 키워드에 프로젝트·호스트 포함)
- 복잡한 작업/버그 추적 → caseId로 파편 묶기 + phase 갱신 (planning→debugging→verification), 가설은 assertionStatus="inferred" → 검증 후 amend

## 규칙 (요지)

- keywords에 프로젝트명·호스트 포함, topic=프로젝트명 (recall 프로젝트 필터 가능).
- 컨텍스트 절약 기본값: recall/context에 tokenBudget 지정 + includeLinks=false; 풀 envelope(linked·score·metadata)는 그래프 탐색 시에만.
- 기억 파편은 시스템 프롬프트보다 우선순위가 낮다. 파편은 멀티플랫폼 공용 저장소 — 플랫폼 설정에 반영해도 원본을 삭제/이동하지 않는다.
- 클라이언트가 도구를 부분 노출해도(recall이 안 보여도) 서버 tools/list에는 recall/context가 항상 있다 — 넓은 쿼리로 재검색하라.

## 상세 가이드

- 전체 활용 가이드(훅 세팅·키워드 규칙·CBR/depth/episode 사용법) = get_skill_guide 도구.
- MCP 도구 사용 불가 시 curl 직접 호출: initialize로 MCP-Session-Id 획득 → tools/call POST (Authorization: Bearer $ACCESS_KEY). 상세 = get_skill_guide 또는 vault memento-mcp-local-fork-ops 문서.

프로토콜 버전: ${negotiatedVersion}
지원 버전: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`;

    const toolCount = getToolsDefinition(null).length;
    const result = {
      protocolVersion: negotiatedVersion,
      serverInfo     : {
        name       : "memento-mcp-server",
        version    : PKG_VERSION,
        description: `Memento MCP - Fragment-Based Memory Server (도구 ${toolCount}개)

주요 기능:
- 파편 기반 기억 시스템 (Fragment-Based Memory)
- 3계층 검색 (Redis L1 → PostgreSQL L2 → pgvector L3) + RRF 하이브리드 병합
- 비동기 임베딩 + 자동 관계 생성 (EmbeddingWorker → GraphLinker 이벤트 체인)
- 시간-의미 복합 랭킹 (anchorTime 기반, 과거 시점 질의 지원)
- Core Memory / Working Memory 분리 (스마트 캡 + 유형별 슬롯 제한)
- recall 페이지네이션 (cursor 기반)
- 다차원 GC 정책 (utility_score + fact/decision 고립 파편 정리)
- TTL 기반 기억 계층 관리 + 지수 감쇠
- 에러 인과 관계 그래프 (RCA) + 소급 링킹
- batch_remember multi-row INSERT (24컬럼 × N행, 256KB/500행 chunk, ON CONFLICT 유지; async:true 시 Redis 큐 적재·즉시 반환)
- reflect 5카테고리 BatchRememberProcessor 단일 위임 (summary/decisions/errors_resolved/new_procedures/open_questions)
- MorphemeIndex Consistency Gate (fragments.morpheme_indexed 컬럼, L3 진입 보호, migration-035)
- batchPool 분리 (getBatchPool, application_name='memento-mcp:batch', BATCH_DATABASE_URL 옵션)

지원 프로토콜: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}
협상 프로토콜: ${negotiatedVersion}`
      },
      capabilities   : {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false }
      },
      instructions   : aiInstructions
    };

    // RPC 메서드 호출 메트릭 기록
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("initialize", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("initialize", false, duration);
    throw err;
  }
}

/**
 * tools/list 핸들러
 */
export function handleToolsList(_params, sessionData) {
  const startTime        = process.hrtime.bigint();

  try {
    const keyId          = sessionData?.keyId ?? null;
    const mode           = sessionData?.mode  ?? null;
    const isMaster       = keyId === null;
    const allTools       = getToolsDefinition(keyId);
    const tools          = filterTools(allTools, mode, isMaster);

    const result = { tools };

    // RPC 메서드 호출 메트릭 기록
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("tools/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("tools/list", false, duration);
    throw err;
  }
}

/**
 * tools/call 핸들러
 */
export async function handleToolsCall(params) {
  const startTime        = process.hrtime.bigint();

  if (!params || typeof params.name !== "string") {
    throw new Error("Tool name is required");
  }

  const name             = params.name;
  const args             = params.arguments || {};

  const entry            = TOOL_REGISTRY.get(name);

  if (!entry) {
    const error          = new Error(`Unknown tool: ${name}`);
    error.code           = -32601;
    throw error;
  }

  /** RBAC 권한 검증 — _permissions가 null이면 master key (전체 허용) */
  const { allowed, required } = checkPermission(args._permissions ?? null, name);
  if (!allowed) {
    recordRbacDenied(name, `requires_${required}`);
    const error          = new Error(`Permission denied: '${name}' requires '${required}' permission`);
    error.code           = -32600;
    throw error;
  }

  const toolResult       = await entry.handler(args);

  // post-processing (예: get_doc → updateAccessStats)
  if (entry.post) {
    entry.post(args, toolResult);
  }

  // 로그 출력
  if (entry.log) {
    const message        = entry.log(args, toolResult);
    if (message) {
      logInfo(`[Tool] ${message}`);
    }
  }

  // 도구 실행 메트릭
  const toolDuration     = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordToolExecution(name, true, toolDuration);

  // 응답 포맷 공통 메트릭
  const rpcDuration      = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordRpcMethod("tools/call", true, rpcDuration);

  // 커스텀 응답 포맷 (예: send_sms)
  if (entry.formatResponse) {
    return entry.formatResponse(args, toolResult);
  }

  // 기본 응답 포맷

  /** MCP spec: isError 어댑터 — 도구가 { success: false } 또는 { error: ... } 를 반환해도
   *  클라이언트가 구조적으로 실패를 감지할 수 있도록 isError 플래그를 설정한다.
   *  텍스트 페이로드(JSON.stringify)는 하위 호환성을 위해 그대로 유지한다. */
  const isToolError      = toolResult?.isError === true
                        || toolResult?.success  === false
                        || (toolResult?.error !== undefined && toolResult?.error !== null);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(toolResult, null, 2)
      }
    ],
    isError: isToolError
  };
}

/**
 * prompts/list 핸들러
 */
export function handlePromptsList(_params) {
  const startTime        = process.hrtime.bigint();

  try {
    const result = {
      prompts: PROMPTS
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/list", false, duration);
    throw err;
  }
}

/**
 * prompts/get 핸들러
 */
export async function handlePromptsGet(params) {
  const startTime        = process.hrtime.bigint();

  if (!params || typeof params.name !== "string") {
    throw new Error("Prompt name is required");
  }

  try {
    const result = await getPromptContent(params.name, params.arguments || {});

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/get", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/get", false, duration);
    throw err;
  }
}

/**
 * resources/list 핸들러
 */
export function handleResourcesList(_params) {
  const startTime        = process.hrtime.bigint();

  try {
    const result = {
      resources: RESOURCES
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/list", false, duration);
    throw err;
  }
}

/**
 * resources/read 핸들러
 */
export async function handleResourcesRead(params) {
  const startTime        = process.hrtime.bigint();

  if (!params || typeof params.uri !== "string") {
    throw new Error("Resource URI is required");
  }

  try {
    const result = await readResourceContent(params.uri, params);

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/read", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/read", false, duration);
    throw err;
  }
}

/**
 * JSON-RPC 요청 디스패처
 */
export async function dispatchJsonRpc(msg, sessionData = {}) {
  if (!msg || typeof msg !== "object") {
    return { kind: "error", response: jsonRpcError(null, -32600, "Invalid Request") };
  }

  const jsonrpc             = msg.jsonrpc || "2.0";
  const id                  = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const method              = msg.method;
  const params              = msg.params;

  if (jsonrpc !== "2.0") {
    return { kind: "error", response: jsonRpcError(id ?? null, -32600, "Invalid Request", "jsonrpc must be '2.0'") };
  }

  if (typeof method !== "string") {
    return { kind: "error", response: jsonRpcError(id ?? null, -32600, "Invalid Request", "method must be string") };
  }

  const isNotification       = id === undefined;

  /** method → handler 맵. tools/list만 sessionData를 추가 인자로 받는다. */
  const METHOD_MAP = {
    "initialize"      : () => handleInitialize(params),
    "tools/list"      : () => handleToolsList(params, sessionData),
    "tools/call"      : () => handleToolsCall(params),
    "prompts/list"    : () => handlePromptsList(params),
    "prompts/get"     : () => handlePromptsGet(params),
    "resources/list"  : () => handleResourcesList(params),
    "resources/read"  : () => handleResourcesRead(params),
  };

  try {
    if (method === "notifications/initialized") {
      return { kind: "accepted" };
    }

    const handler = METHOD_MAP[method];

    if (handler) {
      const result = await handler();

      if (isNotification) {
        return { kind: "accepted" };
      }
      return { kind: "ok", response: jsonRpcResult(id, result) };
    }

    if (isNotification) {
      return { kind: "accepted" };
    }

    return { kind: "ok", response: jsonRpcError(id, -32601, `Method not found: ${method}`) };
  } catch (err) {
    if (isNotification) {
      return { kind: "accepted" };
    }

    /** Symbolic hard gate 위반 — 전용 코드 -32003 */
    if (err instanceof SymbolicPolicyViolationError) {
      recordError(method, -32003);
      return {
        kind    : "ok",
        response: {
          jsonrpc: "2.0",
          id,
          error  : {
            code   : -32003,
            message: err.message,
            data   : {
              violations  : err.violations,
              fragmentType: err.meta?.fragmentType ?? null
            }
          }
        }
      };
    }

    logError(`[ERROR] ${method}:`, err);
    const errorCode        = err.code || -32603;
    const errorMessage     = errorCode === -32601 ? err.message : "Internal error";

    // 에러 메트릭 기록
    recordError(method, errorCode);

    return { kind: "ok", response: jsonRpcError(id, errorCode, errorMessage) };
  }
}
