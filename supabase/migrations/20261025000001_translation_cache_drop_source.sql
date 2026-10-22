-- 번역 캐시에서 원문(source_text)을 제거한다 (Release 1).
--
-- 캐시 조회는 source_language/target_language/source_hash 로만 이루어지므로
-- 원문을 보관할 이유가 없다. 기존 행의 원문도 이 마이그레이션에서 함께 삭제된다.
--
-- 롤아웃 순서 (반드시 지킬 것):
--   1) 20261025000000_translation_cache_private.sql 적용
--   2) translate 함수를 source_text 없이 배포
--   3) 이 마이그레이션 적용 — 열과 기존 원문 삭제
--
-- 함수 배포가 먼저다. 열이 없는 상태에서 이전 함수가 실행되면 INSERT 가
-- 실패해 캐시가 채워지지 않는다(응답은 그대로 나가지만 캐시 적중률만 떨어진다).
-- source_hash 는 계속 조회 키로 쓰이므로 남긴다.

alter table public.translation_cache drop column if exists source_text;
