-- 동기화 워터마크 — **서버가 찍는** 시각.
--
-- 클라이언트의 updated_at/last_seen_at 은 기기 시계라 워터마크로 쓰면 시계가
-- 뒤진 기기의 변경을 건너뛸 수 있다. 서버가 now() 로 찍는 열을 따로 두고,
-- 클라이언트는 "이 시각 이후에 바뀐 행" 만 받는다.
alter table public.documents
  add column server_updated_at timestamptz not null default now();
alter table public.folders
  add column server_updated_at timestamptz not null default now();
alter table public.word_states
  add column server_updated_at timestamptz not null default now();
alter table public.document_tombstones
  add column server_updated_at timestamptz not null default now();

create or replace function public.set_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  return new;
end;
$$;

drop trigger if exists documents_server_updated_at on public.documents;
create trigger documents_server_updated_at
  before insert or update on public.documents
  for each row execute function public.set_server_updated_at();

drop trigger if exists folders_server_updated_at on public.folders;
create trigger folders_server_updated_at
  before insert or update on public.folders
  for each row execute function public.set_server_updated_at();

drop trigger if exists word_states_server_updated_at on public.word_states;
create trigger word_states_server_updated_at
  before insert or update on public.word_states
  for each row execute function public.set_server_updated_at();

drop trigger if exists document_tombstones_server_updated_at on public.document_tombstones;
create trigger document_tombstones_server_updated_at
  before insert or update on public.document_tombstones
  for each row execute function public.set_server_updated_at();

-- 등장 기록이 바뀌면 문서의 서버 시각을 올린다. 다른 기기는 그 문서만 다시 받는다.
create or replace function public.replace_word_occurrences(
  p_document_id uuid,
  p_rows jsonb
)
returns void
language plpgsql
security invoker
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.word_occurrences
  where user_id = auth.uid()
    and document_id = p_document_id;

  insert into public.word_occurrences (
    user_id, document_id, language_code, lemma, surface,
    char_start, char_end, sentence, occurrences_count
  )
  select
    auth.uid(),
    p_document_id,
    entry->>'language_code',
    entry->>'lemma',
    entry->>'surface',
    (entry->>'char_start')::int,
    (entry->>'char_end')::int,
    entry->>'sentence',
    coalesce((entry->>'occurrences_count')::int, 1)
  from jsonb_array_elements(p_rows) as entry;

  update public.documents
  set server_updated_at = now()
  where user_id = auth.uid()
    and id = p_document_id;
end;
$$;
