/**
 * SearchEventRecorder 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-25
 *
 * 순수 함수(classifyQueryType, extractFilterKeys, buildSearchEvent)만 검증한다.
 * recordSearchEvent(DB 연결 필요)는 테스트하지 않는다.
 */

import {
  classifyQueryType,
  extractFilterKeys,
  serializeQueryText,
  buildSearchEvent
} from "../lib/memory/SearchEventRecorder.js";

// ---------------------------------------------------------------------------
// classifyQueryType
// ---------------------------------------------------------------------------

describe("classifyQueryType", () => {
  it("빈 객체는 keywords를 반환한다", () => {
    expect(classifyQueryType({})).toBe("keywords");
  });

  it("null/undefined 입력은 keywords를 반환한다", () => {
    expect(classifyQueryType(null)).toBe("keywords");
    expect(classifyQueryType(undefined)).toBe("keywords");
  });

  it("text만 있으면 text를 반환한다", () => {
    expect(classifyQueryType({ text: "hello" })).toBe("text");
  });

  it("keywords만 있으면 keywords를 반환한다", () => {
    expect(classifyQueryType({ keywords: ["foo", "bar"] })).toBe("keywords");
  });

  it("topic만 있으면 topic을 반환한다", () => {
    expect(classifyQueryType({ topic: "architecture" })).toBe("topic");
  });

  it("text + keywords는 mixed를 반환한다", () => {
    expect(classifyQueryType({ text: "hello", keywords: ["a"] })).toBe("mixed");
  });

  it("text + topic은 mixed를 반환한다", () => {
    expect(classifyQueryType({ text: "hello", topic: "arch" })).toBe("mixed");
  });

  it("keywords + topic은 mixed를 반환한다", () => {
    expect(classifyQueryType({ keywords: ["a"], topic: "arch" })).toBe("mixed");
  });

  it("세 필드 모두 있으면 mixed를 반환한다", () => {
    expect(classifyQueryType({ text: "t", keywords: ["k"], topic: "tp" })).toBe("mixed");
  });

  it("빈 문자열 text는 없는 것으로 처리된다", () => {
    expect(classifyQueryType({ text: "" })).toBe("keywords");
  });

  it("빈 배열 keywords는 없는 것으로 처리된다", () => {
    expect(classifyQueryType({ keywords: [] })).toBe("keywords");
  });
});

// ---------------------------------------------------------------------------
// extractFilterKeys
// ---------------------------------------------------------------------------

describe("extractFilterKeys", () => {
  it("빈 객체는 빈 배열을 반환한다", () => {
    expect(extractFilterKeys({})).toEqual([]);
  });

  it("null/undefined 입력은 빈 배열을 반환한다", () => {
    expect(extractFilterKeys(null)).toEqual([]);
    expect(extractFilterKeys(undefined)).toEqual([]);
  });

  it("topic이 있으면 'topic'을 포함한다", () => {
    expect(extractFilterKeys({ topic: "arch" })).toContain("topic");
  });

  it("type이 있으면 'type'을 포함한다", () => {
    expect(extractFilterKeys({ type: "fact" })).toContain("type");
  });

  it("isAnchor가 있으면 'is_anchor'를 포함한다", () => {
    expect(extractFilterKeys({ isAnchor: true })).toContain("is_anchor");
    expect(extractFilterKeys({ isAnchor: false })).toContain("is_anchor");
  });

  it("includeSuperseded가 있으면 'includeSuperseded'를 포함한다", () => {
    expect(extractFilterKeys({ includeSuperseded: true })).toContain("includeSuperseded");
  });

  it("minImportance가 있으면 'minImportance'를 포함한다", () => {
    expect(extractFilterKeys({ minImportance: 0.5 })).toContain("minImportance");
  });

  it("keyId가 있으면 'key_id'를 포함한다", () => {
    expect(extractFilterKeys({ keyId: 42 })).toContain("key_id");
  });

  it("keyId가 null이면 'key_id'를 포함하지 않는다", () => {
    expect(extractFilterKeys({ keyId: null })).not.toContain("key_id");
  });

  it("여러 필드가 있으면 모두 포함한다", () => {
    const keys = extractFilterKeys({ topic: "x", type: "fact", isAnchor: true, keyId: 1 });
    expect(keys).toContain("topic");
    expect(keys).toContain("type");
    expect(keys).toContain("is_anchor");
    expect(keys).toContain("key_id");
  });

  it("undefined 필드는 포함하지 않는다", () => {
    expect(extractFilterKeys({ topic: undefined })).not.toContain("topic");
  });
});

// ---------------------------------------------------------------------------
// serializeQueryText
// ---------------------------------------------------------------------------

describe("serializeQueryText", () => {
  it("null/undefined 입력은 null을 반환한다", () => {
    expect(serializeQueryText(null)).toBeNull();
    expect(serializeQueryText(undefined)).toBeNull();
  });

  it("빈 객체는 null을 반환한다", () => {
    expect(serializeQueryText({})).toBeNull();
  });

  it("text만 있으면 text 키만 직렬화한다", () => {
    expect(JSON.parse(serializeQueryText({ text: "hello" }))).toEqual({ text: "hello" });
  });

  it("keywords만 있으면 keywords 키만 직렬화한다", () => {
    expect(JSON.parse(serializeQueryText({ keywords: ["a", "b"] }))).toEqual({ keywords: ["a", "b"] });
  });

  it("topic만 있으면 topic 키만 직렬화한다", () => {
    expect(JSON.parse(serializeQueryText({ topic: "arch" }))).toEqual({ topic: "arch" });
  });

  it("세 필드 모두 직렬화한다", () => {
    expect(JSON.parse(serializeQueryText({ text: "t", keywords: ["k"], topic: "tp" })))
      .toEqual({ text: "t", keywords: ["k"], topic: "tp" });
  });

  it("빈 문자열·빈 배열은 없는 것으로 처리한다", () => {
    expect(serializeQueryText({ text: "", keywords: [] })).toBeNull();
  });

  it("필터 전용 필드(type/isAnchor)는 직렬화하지 않는다", () => {
    expect(serializeQueryText({ type: "fact", isAnchor: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSearchEvent
// ---------------------------------------------------------------------------

describe("buildSearchEvent", () => {
  it("searchPath에서 L1/L2/L3 카운트를 파싱한다", () => {
    const event = buildSearchEvent(
      { keywords: ["a"] },
      [{ id: 1 }, { id: 2 }],
      { searchPath: "L1:5 → HotCache:3 → L2:10 → L3:8 → RRF" }
    );
    expect(event.l1_count).toBe(5);
    expect(event.l2_count).toBe(10);
    expect(event.l3_count).toBe(8);
  });

  it("RRF 포함 경로에서 used_rrf가 true이다", () => {
    const event = buildSearchEvent(
      {},
      [],
      { searchPath: "L1:3 → L2:7 → RRF" }
    );
    expect(event.used_rrf).toBe(true);
  });

  it("RRF 미포함 경로에서 used_rrf가 false이다", () => {
    const event = buildSearchEvent(
      {},
      [],
      { searchPath: "L1:3 → HotCache:2" }
    );
    expect(event.used_rrf).toBe(false);
  });

  it("searchPath 없으면 모든 카운트가 0이다", () => {
    const event = buildSearchEvent({}, [], {});
    expect(event.l1_count).toBe(0);
    expect(event.l2_count).toBe(0);
    expect(event.l3_count).toBe(0);
    expect(event.used_rrf).toBe(false);
  });

  it("result 배열 길이가 result_count에 반영된다", () => {
    const event = buildSearchEvent({}, [{ id: 1 }, { id: 2 }, { id: 3 }], {});
    expect(event.result_count).toBe(3);
  });

  it("빈 result는 result_count가 0이다", () => {
    const event = buildSearchEvent({}, [], {});
    expect(event.result_count).toBe(0);
  });

  it("meta.sessionId, keyId, latencyMs, l1IsFallback이 올바르게 매핑된다", () => {
    const event = buildSearchEvent(
      {},
      [],
      { sessionId: "sess-1", keyId: 7, latencyMs: 42, l1IsFallback: true }
    );
    expect(event.session_id).toBe("sess-1");
    expect(event.key_id).toBe(7);
    expect(event.latency_ms).toBe(42);
    expect(event.l1_is_fallback).toBe(true);
  });

  it("meta가 없으면 선택 필드들이 null/false 기본값을 갖는다", () => {
    const event = buildSearchEvent({}, []);
    expect(event.session_id).toBeNull();
    expect(event.key_id).toBeNull();
    expect(event.latency_ms).toBeNull();
    expect(event.l1_is_fallback).toBe(false);
  });

  it("query_type과 filter_keys가 순수 함수 결과와 일치한다", () => {
    const query = { text: "hello", topic: "arch", isAnchor: true };
    const event = buildSearchEvent(query, [], {});
    expect(event.query_type).toBe("mixed");
    expect(event.filter_keys).toContain("topic");
    expect(event.filter_keys).toContain("is_anchor");
  });

  it("query_text가 순수 함수 결과와 일치한다", () => {
    const query = { text: "hello", keywords: ["a", "b"], topic: "arch" };
    const event = buildSearchEvent(query, [], {});
    expect(event.query_text).toBe(serializeQueryText(query));
    expect(JSON.parse(event.query_text)).toEqual({
      text: "hello", keywords: ["a", "b"], topic: "arch"
    });
  });

  it("검색어가 없으면 query_text가 null이다", () => {
    expect(buildSearchEvent({}, []).query_text).toBeNull();
  });

  it("L1 전용 폴백 경로도 올바르게 파싱된다", () => {
    const event = buildSearchEvent(
      { keywords: ["k"] },
      [{ id: 1 }],
      { searchPath: "L1:15 (fallback)", l1IsFallback: true }
    );
    expect(event.l1_count).toBe(15);
    expect(event.l2_count).toBe(0);
    expect(event.l3_count).toBe(0);
    expect(event.l1_is_fallback).toBe(true);
  });
});
