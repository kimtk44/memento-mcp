-- NOTE: vector_cosine_ops is auto-replaced by migrate.js with the correct
--       ops class (halfvec_cosine_ops when embedding column is halfvec type).
-- migration-050 (fork; was fork migration-038-morpheme-dict-dim-fix, renumbered at the v5.10.0 cutover): morpheme_dict 임베딩 차원 1536 -> 1024 정정
--
-- 배경: migration-008은 embedding을 vector(1536)으로 만들었다(당시 1536-dim 모델
-- 기준). 현 파이프라인은 bge-m3(1024-dim)이라 fragments.embedding = vector(1024)
-- 인데 morpheme_dict만 1536으로 남아, 형태소 임베딩 INSERT가
-- "expected 1536 dimensions, not 1024"로 실패하고 L3 형태소 sub-path가 무력화된다.
--
-- morpheme_dict은 (morpheme -> embedding) 파생 캐시이며 recall 시 lazy 재생성되므로
-- DROP 후 재생성해도 영구 데이터 손실이 없다. 차원은 fragments.embedding /
-- EMBEDDING_DIMENSIONS와 항상 일치해야 한다(모델 교체 시 동반 마이그레이션 필요).

-- [2026-08-14] 조건부화. 이 파일은 라이브에 psql로 직접 적용됐고 schema_migrations에는
-- 기록되지 않았다(당시 최신 기록 = 037). 그대로 두면 migrate.js가 미적용으로 판정해
-- DROP TABLE CASCADE를 재실행, 16,495행 형태소 캐시를 날린다. 선언 차원이 이미 맞으면
-- no-op이 되도록 감싼다. 신규 설치(테이블 부재 = NULL)에서는 종전대로 생성된다.
-- [2026-08-24] 목표 차원을 fragments.embedding의 atttypmod에서 파생 (구현은 1024
-- 리터럴 하드코딩이었음 — 비-1024 배포에서 건강한 morpheme_dict를 "차원 불일치"로
-- 오판해 파괴하는 반대 방향 재발 경로). morpheme_dict의 규약은 "fragments.embedding
-- 과 항상 동일 차원"이므로 비교 기준도 그 컬럼이어야 한다. pgvector의 atttypmod는
-- 차원값 그대로다(기존 1024 비교가 동작한 근거).
DO $$
DECLARE morph_dim int; frag_dim int;
BEGIN
  SELECT a.atttypmod INTO frag_dim
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'agent_memory'
     AND c.relname = 'fragments'
     AND a.attname = 'embedding'
     AND NOT a.attisdropped;

  IF frag_dim IS NULL OR frag_dim < 1 THEN
    RAISE NOTICE 'fragments.embedding dimension unknown - skipping morpheme_dict migration (no alignment target)';
    RETURN;
  END IF;

  SELECT a.atttypmod INTO morph_dim
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'agent_memory'
     AND c.relname = 'morpheme_dict'
     AND a.attname = 'embedding'
     AND NOT a.attisdropped;

  IF morph_dim IS NOT DISTINCT FROM frag_dim THEN
    RAISE NOTICE 'morpheme_dict.embedding already vector(%) aligned with fragments - skipping (cache preserved)', frag_dim;
    RETURN;
  END IF;

  DROP TABLE IF EXISTS agent_memory.morpheme_dict CASCADE;
  EXECUTE format(
    'CREATE TABLE agent_memory.morpheme_dict (
       morpheme   TEXT                     PRIMARY KEY,
       embedding  vector(%s),
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )', frag_dim);
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_morpheme_dict_embedding
    ON agent_memory.morpheme_dict
    USING hnsw (embedding vector_cosine_ops)';
END $$;
