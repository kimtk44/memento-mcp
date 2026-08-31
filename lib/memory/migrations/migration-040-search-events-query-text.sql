-- migration-040-search-events-query-text.sql
--
-- search_events.query_text 컬럼을 마이그레이션에 편입한다.
--
-- 배경: 이 컬럼은 라이브 DB(memento)에는 이미 존재했으나 어떤 마이그레이션에도
-- 정의가 없었다 — 애드혹 ALTER로 추가된 뒤 배선이 되지 않은 상태였다.
-- 그 결과 (a) 마이그레이션만으로 스키마를 재구축하면 컬럼이 없어 INSERT가 깨지고,
-- (b) SearchEventRecorder가 값을 넣지 않아 3,245행 전량 NULL이었다.
-- 2026-08-31 SearchEventRecorder.extractQueryText()로 기록을 배선하면서
-- 스키마 정의도 여기에 정식 편입한다.
--
-- IF NOT EXISTS이므로 컬럼이 이미 있는 라이브 DB에서는 무연산이다.

ALTER TABLE agent_memory.search_events
  ADD COLUMN IF NOT EXISTS query_text TEXT;

COMMENT ON COLUMN agent_memory.search_events.query_text IS
  'replay용 자유텍스트 쿼리 표면(text + keywords, 둘 다 없으면 topic). 최대 2000자 후 절단 마커.';
