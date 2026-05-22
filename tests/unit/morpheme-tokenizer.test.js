import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { segmentByScript, tokenizeLocal } from "../../lib/memory/embedding/MorphemeTokenizer.js";

describe("segmentByScript", () => {
  test("한·영 혼용을 스크립트 런으로 분리", () => {
    const segs = segmentByScript("memento 임베딩 비용");
    assert.deepEqual(segs, [
      { script: "latin",  text: "memento" },
      { script: "hangul", text: "임베딩" },
      { script: "hangul", text: "비용" },
    ]);
  });

  test("한자·가나·숫자 분류", () => {
    const segs = segmentByScript("中文テスト123");
    assert.deepEqual(segs.map(s => s.script), ["han", "kana", "other"]);
  });

  test("코드 토큰 memento-mcp는 라틴 런으로 유지", () => {
    const segs = segmentByScript("memento-mcp L3");
    assert.equal(segs[0].script, "latin");
    assert.ok(segs.some(s => s.text.includes("memento-mcp")));
  });
});

describe("tokenizeLocal", () => {
  test("한국어 코드 혼용 형태소 추출", async () => {
    const m = await tokenizeLocal("memento-mcp 임베딩 비용을 절감했다", 10);
    assert.ok(m.includes("임베딩"));
    assert.ok(m.includes("비용"));
    assert.ok(m.some(t => t.toLowerCase().includes("memento")));
    assert.ok(m.length <= 10);
  });

  test("조사·어미·단음절 기능 형태소는 제외된다", async () => {
    const m = await tokenizeLocal("비용을 절감했다", 10);
    assert.ok(!m.includes("을"));        // 조사 제거
    assert.ok(!m.includes("다"));        // 어미 제거
    assert.ok(m.every(t => t.length > 1)); // 단음절 전면 제외
    assert.ok(m.includes("비용"));        // 의미 형태소 보존
  });

  test("중국어 분절", async () => {
    const m = await tokenizeLocal("中文分词测试", 10);
    assert.ok(m.includes("中文"));
  });

  test("빈 입력은 빈 배열", async () => {
    assert.deepEqual(await tokenizeLocal("", 10), []);
  });
});
