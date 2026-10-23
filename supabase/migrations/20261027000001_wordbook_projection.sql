-- Wordbook projection and document version metadata (R3, task 3).
--
-- The wordbook becomes a server-owned read model so a new device can download
-- the complete wordbook without downloading every occurrence row or document
-- body. This migration creates the projection table, backfills it from the R2
-- source tables, and adds the document metadata columns that let a client tell
-- "opened" apart from "content changed".
--
-- No refresh triggers live here. Task 4 owns the set-based refresh functions and
-- the triggers that keep the projection current after this initial backfill.
-- Clients can only SELECT projection rows: there is no client write path and no
-- INSERT/UPDATE/DELETE policy.

-- ---------------------------------------------------------------------------
-- documents: version columns
--
-- updated_at stays as the R2 "last looked at" compatibility column. The new
-- columns split the signals that R2 overloaded:
--   - last_opened_at: opening a document does not imply a content change;
--   - content_updated_at: only raw_text/language_code edits;
--   - occurrences_updated_at: only occurrence writes (Task 4 maintains it);
--   - char_count: char_length(raw_text), maintained by a trigger so document
--     lists can show length and sort by length without downloading raw_text.
--
-- char_count is a plain column, not a generated column: a generated column
-- would make every metadata read materialize the document text.
-- ---------------------------------------------------------------------------

alter table public.documents
  add column last_opened_at timestamptz,
  add column content_updated_at timestamptz,
  add column occurrences_updated_at timestamptz,
  add column char_count int not null default 0;

comment on column public.documents.last_opened_at is
  '마지막으로 연 시각. 내용 변경과 무관하다.';
comment on column public.documents.content_updated_at is
  'raw_text 또는 language_code 가 바뀐 시각. 열람·제목 변경과 무관하다.';
comment on column public.documents.occurrences_updated_at is
  '문서의 등장 기록이 바뀐 시각. 열람·내용 변경과 무관하다.';
comment on column public.documents.char_count is
  'char_length(raw_text). 내용을 내려받지 않고도 길이 표시·정렬에 쓴다.';

-- Backfill legacy rows without firing the R2 document triggers. Firing
-- documents_server_updated_at here would advance every document watermark and
-- make every device re-download every document just because a migration ran.
create or replace function public.backfill_document_metadata()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only rows that have never been filled in. Re-running this maintenance
  -- function must not overwrite a real content_updated_at with created_at.
  update public.documents
  set last_opened_at = updated_at,
      content_updated_at = created_at,
      occurrences_updated_at = updated_at,
      char_count = char_length(raw_text)
  where last_opened_at is null
     or content_updated_at is null
     or occurrences_updated_at is null
     or char_count <> char_length(raw_text);
end;
$$;

revoke all on function public.backfill_document_metadata() from public, anon, authenticated;

alter table public.documents disable trigger user;
select public.backfill_document_metadata();
alter table public.documents enable trigger user;

-- Maintain the version columns on every write. Keeping this in one BEFORE
-- trigger (rather than in client code) means R2 clients that only know
-- raw_text/updated_at still keep the new metadata truthful.
create or replace function public.set_document_versions()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.char_count := char_length(new.raw_text);

  if tg_op = 'INSERT' then
    -- Creating a document is also the first time it is opened. Preserve an
    -- explicit client value if one was sent.
    new.last_opened_at := coalesce(new.last_opened_at, new.updated_at, clock_timestamp());
    new.content_updated_at := coalesce(new.content_updated_at, clock_timestamp());
    return new;
  end if;

  -- A title/folder/trash-only update must not look like a content edit.
  if new.raw_text is distinct from old.raw_text
     or new.language_code is distinct from old.language_code then
    new.content_updated_at := clock_timestamp();
  end if;

  return new;
end;
$$;

create trigger documents_set_versions
  before insert or update on public.documents
  for each row execute function public.set_document_versions();

-- ---------------------------------------------------------------------------
-- wordbook_entries: one derived row per (user, language, lemma)
--
-- `contexts` stores [{documentId, sentence}] rather than a document title so a
-- rename does not rewrite every projection row. `deleted_at` lets an
-- incremental pull propagate the removal of a word whose last occurrence is
-- gone. State fields mirror word_states so the client can hydrate offline.
-- ---------------------------------------------------------------------------

create table public.wordbook_entries (
  user_id             uuid        not null references auth.users on delete cascade,
  language_code       text        not null,
  lemma               text        not null,
  surfaces            text[]      not null default '{}',
  contexts            jsonb       not null default '[]',
  occurrence_count    int         not null default 0,
  document_count      int         not null default 0,
  status              public.word_status,
  is_favorite         boolean     not null default false,
  star_angle          int         not null default 0,
  star_color          text        not null default '#eab308',
  seen_count          int         not null default 1,
  first_seen_at       timestamptz,
  last_seen_at        timestamptz,
  favorite_updated_at timestamptz,
  known_presses       int         not null default 0,
  unsure_presses      int         not null default 0,
  unknown_presses     int         not null default 0,
  note                text,
  note_updated_at     timestamptz,
  deleted_at          timestamptz,
  server_updated_at   timestamptz not null default clock_timestamp(),
  primary key (user_id, language_code, lemma)
);

comment on table public.wordbook_entries is
  '서버가 만드는 단어장 읽기 모델. 클라이언트는 읽기만 한다.';
comment on column public.wordbook_entries.occurrence_count is
  '문서별 (document_id, lemma) 등장 횟수를 한 번씩만 더한 값. 표기 행마다 더하지 않는다.';
comment on column public.wordbook_entries.contexts is
  '[{documentId, sentence}] — (문서, 문장) 단위로 중복을 제거하고 빈 문장은 뺀다.';
comment on column public.wordbook_entries.deleted_at is
  '마지막 등장이 사라진 시각. NULL 이면 살아 있는 단어장 항목.';

-- Incremental projection pulls page by (language_code, lemma) after a
-- server_updated_at watermark.
create index wordbook_entries_user_updated_idx
  on public.wordbook_entries (user_id, server_updated_at, language_code, lemma);

create trigger wordbook_entries_server_updated_at
  before insert or update on public.wordbook_entries
  for each row execute function public.set_server_updated_at();

-- ---------------------------------------------------------------------------
-- RLS and grants: read-only to the owning user.
-- ---------------------------------------------------------------------------

alter table public.wordbook_entries enable row level security;

create policy "wordbook_entries own read" on public.wordbook_entries
  for select using (auth.uid() = user_id);

-- Supabase's default privileges grant table access to anon/authenticated, so
-- revoke them explicitly; without this the anon role could read the table.
revoke all on table public.wordbook_entries from public, anon, authenticated;
grant select on table public.wordbook_entries to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill from R2 source tables
--
-- Counts:
--   word_occurrences has one row per (document, lemma, surface) and repeats the
--   same occurrences_count on each surface row. occurrence_count takes the
--   count once per (document, lemma) and only then sums across documents, so a
--   word with two surfaces does not double its count.
--
-- Contexts:
--   distinct (document_id, sentence) per lemma; whitespace-only/empty
--   sentences are not contexts. documentId is stored instead of a title.
--
-- States:
--   word_states supplies status/star/note/counters. A state with no occurrence
--   is not part of the projection (the word has not appeared in any document).
-- ---------------------------------------------------------------------------

create or replace function public.backfill_wordbook_entries()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  with per_document as (
    select
      o.user_id,
      o.language_code,
      o.lemma,
      o.document_id,
      -- Every surface row of one (document, lemma) carries the same count.
      -- max() picks that value once without depending on row order.
      max(o.occurrences_count)::int as occurrences_count
    from public.word_occurrences o
    group by o.user_id, o.language_code, o.lemma, o.document_id
  ),
  totals as (
    select
      p.user_id,
      p.language_code,
      p.lemma,
      count(*)::int as document_count,
      sum(p.occurrences_count)::int as occurrence_count
    from per_document p
    group by p.user_id, p.language_code, p.lemma
  ),
  surfaces as (
    select
      o.user_id,
      o.language_code,
      o.lemma,
      array_agg(distinct o.surface order by o.surface) as surfaces
    from public.word_occurrences o
    group by o.user_id, o.language_code, o.lemma
  ),
  contexts as (
    select
      c.user_id,
      c.language_code,
      c.lemma,
      jsonb_agg(
        jsonb_build_object('documentId', c.document_id, 'sentence', c.sentence)
        order by c.document_id, c.sentence
      ) as contexts
    from (
      select distinct
        o.user_id,
        o.language_code,
        o.lemma,
        o.document_id,
        o.sentence
      from public.word_occurrences o
      where btrim(o.sentence) <> ''
    ) c
    group by c.user_id, c.language_code, c.lemma
  )
  insert into public.wordbook_entries (
    user_id, language_code, lemma,
    surfaces, contexts, occurrence_count, document_count,
    status, is_favorite, star_angle, star_color,
    seen_count, first_seen_at, last_seen_at, favorite_updated_at,
    known_presses, unsure_presses, unknown_presses,
    note, note_updated_at,
    deleted_at
  )
  select
    t.user_id,
    t.language_code,
    t.lemma,
    s.surfaces,
    coalesce(c.contexts, '[]'::jsonb),
    t.occurrence_count,
    t.document_count,
    ws.status,
    coalesce(ws.is_favorite, false),
    coalesce(ws.star_angle::int, 0),
    coalesce(ws.star_color, '#eab308'),
    coalesce(ws.seen_count, 1),
    ws.first_seen_at,
    ws.last_seen_at,
    ws.favorite_updated_at,
    coalesce(ws.known_presses, 0),
    coalesce(ws.unsure_presses, 0),
    coalesce(ws.unknown_presses, 0),
    ws.note,
    ws.note_updated_at,
    null
  from totals t
  join surfaces s
    on s.user_id = t.user_id
   and s.language_code = t.language_code
   and s.lemma = t.lemma
  left join contexts c
    on c.user_id = t.user_id
   and c.language_code = t.language_code
   and c.lemma = t.lemma
  left join public.word_states ws
    on ws.user_id = t.user_id
   and ws.language_code = t.language_code
   and ws.lemma = t.lemma
  on conflict (user_id, language_code, lemma) do update
  set surfaces = excluded.surfaces,
      contexts = excluded.contexts,
      occurrence_count = excluded.occurrence_count,
      document_count = excluded.document_count,
      status = excluded.status,
      is_favorite = excluded.is_favorite,
      star_angle = excluded.star_angle,
      star_color = excluded.star_color,
      seen_count = excluded.seen_count,
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at,
      favorite_updated_at = excluded.favorite_updated_at,
      known_presses = excluded.known_presses,
      unsure_presses = excluded.unsure_presses,
      unknown_presses = excluded.unknown_presses,
      note = excluded.note,
      note_updated_at = excluded.note_updated_at,
      -- The lemma is back (or is being rebuilt); revive it.
      deleted_at = null;
end;
$$;

revoke all on function public.backfill_wordbook_entries() from public, anon, authenticated;

select public.backfill_wordbook_entries();
