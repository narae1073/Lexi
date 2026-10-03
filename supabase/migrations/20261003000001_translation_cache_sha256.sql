-- translation_cache.source_hash 는 Edge Function 이 계산하는 SHA-256(64자) 이다.
-- 최초 스키마는 md5(32자) 로 작성했으나 Deno 표준 Web Crypto 가 MD5 를 지원하지 않는다.

alter table public.translation_cache
  drop constraint if exists translation_cache_source_hash_check;

alter table public.translation_cache
  add constraint translation_cache_source_hash_check check (source_hash ~ '^[0-9a-f]{64}$');