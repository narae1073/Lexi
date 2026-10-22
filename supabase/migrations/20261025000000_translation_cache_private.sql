-- 번역 캐시를 비공개로 전환한다 (Release 1).
--
-- translation_cache 에는 사용자가 입력한 문장(source_text)이 저장되어 있었고,
-- "누구나 읽기" SELECT 정책이 열려 있어 anon 키만 있으면 원문을 읽을 수 있었다.
-- 캐시 읽기/쓰기는 translate Edge Function 이 서비스 롤로만 수행하므로
-- anon/authenticated 의 테이블 권한과 공개 SELECT 정책을 모두 제거한다.
--
-- 롤아웃 순서 (반드시 지킬 것):
--   1) 이 마이그레이션 적용 — 공개 SELECT 정책 제거 + anon/authenticated 권한 회수
--   2) translate 함수를 source_text 없이 배포
--   3) 20261025000001_translation_cache_drop_source.sql 적용
--
-- 순서를 바꾸면 안 된다. 열을 먼저 지우면 이전 함수의 INSERT 가 실패해 캐시
-- 쓰기가 멈춘다. 기존 캐시 행은 이 시점부터 비공개가 되고, 그 안의 원문은
-- 3)에서 열과 함께 삭제된다.

drop policy if exists "translation_cache read" on public.translation_cache;

revoke all on table public.translation_cache from anon, authenticated;
