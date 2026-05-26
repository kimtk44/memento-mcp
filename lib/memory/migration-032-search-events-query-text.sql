-- migration-032-search-events-query-text.sql
-- 검색 이벤트에 원본 쿼리 텍스트 컬럼 추가
-- query_type(분류)·filter_keys(필터명)만으로는 "무엇을 검색했는지" 복원 불가 →
-- text/keywords/topic 원본을 JSON 문자열로 보존하여 디버깅 시 쿼리 파라미터 확인 가능.
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-032-search-events-query-text.sql

ALTER TABLE agent_memory.search_events
  ADD COLUMN IF NOT EXISTS query_text TEXT;
