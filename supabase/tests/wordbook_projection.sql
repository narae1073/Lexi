-- Server-owned wordbook projection: schema, backfill, document versions, RLS.
--
-- Run after `npx supabase db reset`:
--   docker exec -i supabase_db_translator psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/wordbook_projection.sql
--
-- Setup and the backfill call run as the database owner. Projection reads then
-- run as `authenticated` / `anon` with request.jwt.claim.sub set, so the RLS and
-- grant boundary is exercised exactly as a client would hit it.

\set user_id '00000000-0000-4000-8000-00000000b001'
\set other_user_id '00000000-0000-4000-8000-00000000b002'

-- Clean any leftover run (cascades remove documents, occurrences, states and
-- projection entries).
delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid);
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  (:'user_id'::uuid, 'authenticated', 'authenticated', 'projection-a@example.test', now(), now(), now()),
  (:'other_user_id'::uuid, 'authenticated', 'authenticated', 'projection-b@example.test', now(), now(), now());

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'projection test', 'fr', 'Le chat dort. Le chat mange.')
returning id as document_id \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'second document', 'fr', 'Un chat noir.')
returning id as second_document_id \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'other_user_id'::uuid, 'other tenant', 'fr', 'Le chien dort.')
returning id as other_document_id \gset

select set_config('test.document_id', :'document_id', false);
select set_config('test.second_document_id', :'second_document_id', false);
select set_config('test.other_document_id', :'other_document_id', false);
select set_config('test.user_id', :'user_id', false);

-- Same lemma twice in one document with two surfaces: occurrences_count is the
-- per-(document, lemma) count and is repeated on every surface row.
insert into public.word_occurrences
  (user_id, document_id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count)
values
  (:'user_id'::uuid, :'document_id'::uuid, 'fr', 'chat', 'chat', 3, 7, 'Le chat dort.', 3),
  (:'user_id'::uuid, :'document_id'::uuid, 'fr', 'chat', 'chats', 19, 24, 'Le chat mange.', 3),
  (:'user_id'::uuid, :'document_id'::uuid, 'fr', 'chien', 'chien', 0, 0, '', 1),
  (:'user_id'::uuid, :'second_document_id'::uuid, 'fr', 'chat', 'chat', 3, 7, 'Un chat noir.', 2),
  (:'other_user_id'::uuid, :'other_document_id'::uuid, 'fr', 'chien', 'chien', 3, 8, 'Le chien dort.', 1);

insert into public.word_states
  (user_id, language_code, lemma, status, seen_count, first_seen_at, last_seen_at,
   is_favorite, favorite_updated_at, star_angle, star_color,
   known_presses, unsure_presses, unknown_presses, note, note_updated_at)
values
  (:'user_id'::uuid, 'fr', 'chat', 'known', 4, now() - interval '2 days', now(),
   true, now() - interval '1 day', 30, '#ff0000', 1, 2, 3, 'note', now() - interval '1 hour'),
  -- A state without an occurrence is not part of the projection.
  (:'user_id'::uuid, 'fr', 'ours', 'unsure', 1, now(), now(), false, now(), 0, '#eab308', 0, 0, 0, null, null);

-- The migration runs this once for existing rows; the test seeds rows after the
-- migration, so it calls the same backfill again to exercise the code path.
select public.backfill_wordbook_entries();

-- ---------------------------------------------------------------------------
-- documents: the four version columns and their values
-- ---------------------------------------------------------------------------

do $$
declare
  v_columns int;
  v_is_nullable text;
  v_data_type text;
  v_is_generated text;
  v_document_id uuid := current_setting('test.document_id')::uuid;
  v_before timestamptz;
  v_after timestamptz;
  v_row public.documents%rowtype;
begin
  select count(*) into v_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'documents'
    and column_name in ('last_opened_at', 'content_updated_at', 'occurrences_updated_at', 'char_count');
  if v_columns <> 4 then
    raise exception 'documents is missing one of the new version columns (found %)', v_columns;
  end if;

  select is_nullable, data_type, is_generated
  into v_is_nullable, v_data_type, v_is_generated
  from information_schema.columns
  where table_schema = 'public' and table_name = 'documents' and column_name = 'char_count';
  if v_is_nullable <> 'NO' or v_data_type <> 'integer' then
    raise exception 'char_count must be a not-null integer (nullable=%, type=%)', v_is_nullable, v_data_type;
  end if;
  if v_is_generated <> 'NEVER' then
    raise exception 'char_count must not be a generated column (is_generated=%)', v_is_generated;
  end if;

  if exists (
    select 1 from public.documents
    where char_count is null
       or char_count <> char_length(raw_text)
  ) then
    raise exception 'char_count does not match char_length(raw_text) for every document';
  end if;

  -- A newly created document is treated as just opened, so "recently opened"
  -- sort still works for R2 clients that never send last_opened_at.
  if (select last_opened_at is null or content_updated_at is null
      from public.documents where id = v_document_id) then
    raise exception 'new document is missing last_opened_at/content_updated_at';
  end if;

  -- Title-only updates do not claim a content change; raw_text edits do.
  select content_updated_at into v_before from public.documents where id = v_document_id;
  update public.documents set title = title || ' (renamed)' where id = v_document_id;
  select content_updated_at into v_after from public.documents where id = v_document_id;
  if v_after is distinct from v_before then
    raise exception 'title-only update changed content_updated_at';
  end if;

  update public.documents set raw_text = raw_text || '!' where id = v_document_id;
  select content_updated_at into v_after from public.documents where id = v_document_id;
  if v_after <= v_before then
    raise exception 'raw_text update did not advance content_updated_at';
  end if;
  if (select char_count from public.documents where id = v_document_id)
     <> (select char_length(raw_text) from public.documents where id = v_document_id) then
    raise exception 'raw_text update did not refresh char_count';
  end if;

  -- Simulate a row that existed before this migration (the reset test database
  -- has none) and replay the same backfill function the migration calls.
  alter table public.documents disable trigger documents_set_versions;
  update public.documents
  set last_opened_at = null,
      content_updated_at = null,
      occurrences_updated_at = null,
      char_count = 0
  where id = v_document_id;
  alter table public.documents enable trigger documents_set_versions;

  perform public.backfill_document_metadata();

  select * into v_row from public.documents where id = v_document_id;
  if v_row.last_opened_at is distinct from v_row.updated_at then
    raise exception 'backfill did not set last_opened_at = updated_at (% vs %)',
      v_row.last_opened_at, v_row.updated_at;
  end if;
  if v_row.content_updated_at is distinct from v_row.created_at then
    raise exception 'backfill did not set content_updated_at = created_at (% vs %)',
      v_row.content_updated_at, v_row.created_at;
  end if;
  if v_row.occurrences_updated_at is distinct from v_row.updated_at then
    raise exception 'backfill did not set occurrences_updated_at = updated_at (% vs %)',
      v_row.occurrences_updated_at, v_row.updated_at;
  end if;
  if v_row.char_count <> char_length(v_row.raw_text) then
    raise exception 'backfill did not set char_count (% vs %)',
      v_row.char_count, char_length(v_row.raw_text);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- wordbook_entries: shape, primary key, index, trigger
-- ---------------------------------------------------------------------------

do $$
declare
  v_columns int;
  v_pk text[];
  v_index_def text;
begin
  select count(*) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'wordbook_entries';
  if v_columns < 22 then
    raise exception 'wordbook_entries has too few columns (%)', v_columns;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'wordbook_entries' and column_name = 'deleted_at'
  ) then
    raise exception 'wordbook_entries has no deleted_at column';
  end if;

  select array_agg(a.attname order by k.ord)
  into v_pk
  from pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.wordbook_entries'::regclass
    and c.contype = 'p';
  if v_pk is distinct from array['user_id', 'language_code', 'lemma'] then
    raise exception 'wordbook_entries primary key is %', v_pk;
  end if;

  select indexdef into v_index_def
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'wordbook_entries'
    and indexname = 'wordbook_entries_user_updated_idx';
  if v_index_def is null
     or v_index_def not like '%(user_id, server_updated_at, language_code, lemma)%' then
    raise exception 'incremental projection index is missing or wrong: %', v_index_def;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.wordbook_entries'::regclass
      and tgname = 'wordbook_entries_server_updated_at'
      and not tgisinternal
  ) then
    raise exception 'wordbook_entries is missing its set_server_updated_at trigger';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Backfilled rows: per-document deduped counts, contexts, state fields
-- ---------------------------------------------------------------------------

do $$
declare
  v_row public.wordbook_entries%rowtype;
  v_chien public.wordbook_entries%rowtype;
  v_document_id uuid := current_setting('test.document_id')::uuid;
  v_second_document_id uuid := current_setting('test.second_document_id')::uuid;
  v_user_id uuid := current_setting('test.user_id')::uuid;
begin
  select * into v_row
  from public.wordbook_entries
  where user_id = v_user_id and language_code = 'fr' and lemma = 'chat';
  if not found then
    raise exception 'backfill did not create the (fr, chat) entry';
  end if;

  -- 3 in the first document (two surface rows must count once) + 2 in the second.
  if v_row.occurrence_count <> 5 then
    raise exception '(fr, chat) occurrence_count is %, expected 5', v_row.occurrence_count;
  end if;
  if v_row.document_count <> 2 then
    raise exception '(fr, chat) document_count is %, expected 2', v_row.document_count;
  end if;
  if v_row.surfaces is distinct from array['chat', 'chats'] then
    raise exception '(fr, chat) surfaces are %, expected {chat,chats}', v_row.surfaces;
  end if;

  if jsonb_array_length(v_row.contexts) <> 3 then
    raise exception '(fr, chat) has % contexts, expected 3', jsonb_array_length(v_row.contexts);
  end if;
  if not v_row.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_document_id, 'sentence', 'Le chat dort.')
     )
     or not v_row.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_document_id, 'sentence', 'Le chat mange.')
     )
     or not v_row.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_second_document_id, 'sentence', 'Un chat noir.')
     ) then
    raise exception '(fr, chat) contexts are wrong: %', v_row.contexts;
  end if;

  if v_row.status <> 'known'
     or not v_row.is_favorite
     or v_row.star_angle <> 30
     or v_row.star_color <> '#ff0000'
     or v_row.seen_count <> 4
     or v_row.known_presses <> 1
     or v_row.unsure_presses <> 2
     or v_row.unknown_presses <> 3
     or v_row.note <> 'note'
     or v_row.first_seen_at is null
     or v_row.last_seen_at is null
     or v_row.favorite_updated_at is null
     or v_row.note_updated_at is null then
    raise exception '(fr, chat) did not copy word_states fields: %', v_row;
  end if;
  if v_row.deleted_at is not null or v_row.server_updated_at is null then
    raise exception '(fr, chat) deleted_at/server_updated_at defaults are wrong';
  end if;

  -- An empty sentence is not a context.
  select * into v_chien
  from public.wordbook_entries
  where user_id = v_user_id and language_code = 'fr' and lemma = 'chien';
  if not found then
    raise exception 'backfill did not create the (fr, chien) entry';
  end if;
  if v_chien.occurrence_count <> 1 or v_chien.document_count <> 1 then
    raise exception '(fr, chien) counts are %/%', v_chien.occurrence_count, v_chien.document_count;
  end if;
  if v_chien.contexts <> '[]'::jsonb then
    raise exception 'empty sentence leaked into contexts: %', v_chien.contexts;
  end if;
  if v_chien.status is not null or v_chien.note is not null or v_chien.first_seen_at is not null then
    raise exception 'state-less entry did not use null defaults: %', v_chien;
  end if;

  -- A word state with no occurrence is not part of the projection.
  if exists (
    select 1 from public.wordbook_entries
    where user_id = v_user_id and language_code = 'fr' and lemma = 'ours'
  ) then
    raise exception 'a word state without an occurrence leaked into the projection';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: authenticated users see their own rows only; anon sees nothing.
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_user_id uuid := current_setting('test.user_id')::uuid;
begin
  if exists (
    select 1 from public.wordbook_entries where user_id <> v_user_id
  ) then
    raise exception 'authenticated caller can see another tenant''s projection rows';
  end if;
  if not exists (
    select 1 from public.wordbook_entries
    where user_id = v_user_id and language_code = 'fr' and lemma = 'chat'
  ) then
    raise exception 'authenticated caller cannot see their own projection rows';
  end if;

  begin
    insert into public.wordbook_entries (user_id, language_code, lemma)
    values (v_user_id, 'fr', 'inserted');
    raise exception 'authenticated caller can insert projection rows';
  exception when insufficient_privilege then
    null;
  end;

  begin
    update public.wordbook_entries set deleted_at = now()
    where user_id = v_user_id and language_code = 'fr' and lemma = 'chat';
    raise exception 'authenticated caller can update projection rows';
  exception when insufficient_privilege then
    null;
  end;

  begin
    delete from public.wordbook_entries
    where user_id = v_user_id and language_code = 'fr' and lemma = 'chat';
    raise exception 'authenticated caller can delete projection rows';
  exception when insufficient_privilege then
    null;
  end;
end $$;

reset role;

set role anon;

do $$
begin
  begin
    perform 1 from public.wordbook_entries limit 1;
    raise exception 'anon can read wordbook_entries';
  exception when insufficient_privilege then
    null;
  end;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------

delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid);
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid);

\echo 'wordbook_projection: PASS'
