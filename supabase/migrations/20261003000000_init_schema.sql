-- Lexi 초기 스키마 (PLAN.md §4)
-- 모든 사용자 데이터는 auth.uid() 기준 RLS로 격리한다.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 열거형
-- ---------------------------------------------------------------------------
create type public.word_status as enum ('known', 'unsure', 'unknown');

-- ---------------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------------

-- 사용자가 등록한 배울 언어 (plan.txt 5줄: 이 목록만 화면에 노출)
create table public.user_languages (
  user_id       uuid        not null references auth.users on delete cascade,
  language_code text        not null check (language_code ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  created_at    timestamptz not null default now(),
  primary key (user_id, language_code)
);

create table public.documents (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users on delete cascade,
  title         text        not null default '제목 없음',
  language_code text        not null check (language_code ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  raw_text      text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index documents_user_updated_idx on public.documents (user_id, updated_at desc);

-- 단어 상태는 전역 저장: 같은 단어는 문서와 무관하게 같은 상태 (PLAN.md §4)
create table public.word_states (
  id            uuid         primary key default gen_random_uuid(),
  user_id       uuid         not null references auth.users on delete cascade,
  language_code text         not null check (language_code ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  lemma         text         not null,
  status        word_status  not null default 'unsure',
  seen_count    int          not null default 1 check (seen_count > 0),
  first_seen_at timestamptz  not null default now(),
  last_seen_at  timestamptz  not null default now(),
  unique (user_id, language_code, lemma)
);
create index word_states_lookup_idx on public.word_states (user_id, language_code, status);

-- 단어 등장 위치 + 예문 (단어장의 문맥 제공)
create table public.word_occurrences (
  id            bigint generated always as identity primary key,
  user_id       uuid        not null references auth.users on delete cascade,
  document_id   uuid        not null references public.documents on delete cascade,
  language_code text        not null,
  lemma         text        not null,
  surface       text        not null,
  char_start    int         not null check (char_start >= 0),
  char_end      int         not null check (char_end >= char_start),
  sentence      text        not null
);
create index word_occurrences_user_lemma_idx
  on public.word_occurrences (user_id, language_code, lemma);
create index word_occurrences_document_idx
  on public.word_occurrences (document_id);

-- ---------------------------------------------------------------------------
-- 공유 캐시 — 사용자 데이터가 아니므로 anon 읽기 허용, 쓰기는 서비스 계정만
-- (API 키를 클라이언트에 노출하지 않기 위해 Edge Function 경유)
-- ---------------------------------------------------------------------------

create table public.translation_cache (
  source_language text        not null,
  target_language text        not null default 'en',
  source_hash     text        not null check (source_hash ~ '^[0-9a-f]{32}$'),
  source_text     text        not null,
  translated_text text        not null,
  created_at      timestamptz not null default now(),
  primary key (source_language, target_language, source_hash)
);

-- 사전은 언어별로 나눠 저장 (plan.txt 5줄)
create table public.dictionary_entries (
  language_code text        not null,
  lemma         text        not null,
  payload       jsonb       not null,
  provider      text        not null,
  fetched_at    timestamptz not null default now(),
  primary key (language_code, lemma)
);

-- ---------------------------------------------------------------------------
-- updated_at 자동 갱신
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.user_languages    enable row level security;
alter table public.documents         enable row level security;
alter table public.word_states       enable row level security;
alter table public.word_occurrences  enable row level security;
alter table public.translation_cache enable row level security;
alter table public.dictionary_entries enable row level security;

-- 사용자 소유 데이터: auth.uid() 일치만 접근
create policy "user_languages own" on public.user_languages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "documents own" on public.documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "word_states own" on public.word_states
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "word_occurrences own" on public.word_occurrences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 캐시: 읽기만 허용. INSERT/UPDATE/DELETE는 service_role 키의 Edge Function만 가능.
create policy "translation_cache read" on public.translation_cache
  for select using (true);

create policy "dictionary_entries read" on public.dictionary_entries
  for select using (true);