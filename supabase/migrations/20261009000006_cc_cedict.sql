-- CC-CEDICT 중영 사전 (PLAN.md — 중국어 사전).
--
-- MDBG 공개 덤프(무료, CC BY-SA)를 파싱해 한 번 넣는다. 갱신도 같은 스크립트로
-- 다시 넣는다. Edge Function 은 이 표만 본다 — 외부 사전 API 쿼터가 없다.
create table public.cc_cedict (
  simplified  text not null,
  traditional text not null,
  -- 숫자 성조 병음 (예: 'Bei3 jing1 Da4 xue2'). 성조 부호는 조회 때 바꾼다.
  pinyin      text not null,
  glosses     text[] not null,
  primary key (simplified, traditional, pinyin)
);
create index cc_cedict_simplified_idx on public.cc_cedict (simplified);
create index cc_cedict_traditional_idx on public.cc_cedict (traditional);

alter table public.cc_cedict enable row level security;

-- 공유 사전: 읽기만 허용. 쓰기는 적재 스크립트(service_role)만 한다.
create policy "cc_cedict read" on public.cc_cedict
  for select using (true);

-- 목표 언어 확장 대비: 캐시 키에 목표 언어를 넣는다.
-- CC-CEDICT 는 중영 전용이지만, 나중에 중불 사전 등이 오면 같은 자리다.
alter table public.dictionary_entries
  add column target_language text not null default 'en';
alter table public.dictionary_entries
  drop constraint dictionary_entries_pkey;
alter table public.dictionary_entries
  add primary key (language_code, lemma, target_language);
