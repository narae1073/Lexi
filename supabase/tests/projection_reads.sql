-- Projection read path: page bounds, keyset resume, RLS, payload, and touch.
--
-- Run after `npx supabase db reset` (or after applying all migrations):
--   docker exec -i supabase_db_translator psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/projection_reads.sql
--
-- Fixtures are seeded as the database owner so server_updated_at can be set to
-- exact values (the projection trigger is disabled for the seed inserts).
-- Every read then runs as `authenticated` with request.jwt.claim.sub set, so
-- the grant and RLS boundaries are exercised exactly as a client hits them.

\set user_id '00000000-0000-4000-8000-00000000c001'
\set other_user_id '00000000-0000-4000-8000-00000000c002'

select set_config('test.user_id', :'user_id', false);
select set_config('test.other_user_id', :'other_user_id', false);
select set_config('test.snapshot', '2026-10-27 12:00:00+00', false);

-- Clean any leftover run. Deleting users cascades documents, occurrences,
-- states, and projection rows.
delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid);
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  (:'user_id'::uuid, 'authenticated', 'authenticated', 'reads-a@example.test', now(), now(), now()),
  (:'other_user_id'::uuid, 'authenticated', 'authenticated', 'reads-b@example.test', now(), now(), now());

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'payload test', 'fr', 'Le chat dort. Le chat mange.')
returning id as document_id \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'other_user_id'::uuid, 'other tenant', 'fr', 'Le chien dort.')
returning id as other_document_id \gset

-- A document with no occurrences: the payload must still be non-null with an
-- empty occurrence array.
insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'empty payload', 'fr', 'No words here.')
returning id as empty_document_id \gset

select set_config('test.document_id', :'document_id', false);
select set_config('test.other_document_id', :'other_document_id', false);
select set_config('test.empty_document_id', :'empty_document_id', false);

insert into public.word_occurrences
  (user_id, document_id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count)
values
  (:'user_id'::uuid, :'document_id'::uuid, 'fr', 'chat', 'chat', 3, 7, 'Le chat dort.', 3),
  (:'user_id'::uuid, :'document_id'::uuid, 'fr', 'chat', 'chats', 19, 24, 'Le chat mange.', 3),
  (:'other_user_id'::uuid, :'other_document_id'::uuid, 'fr', 'chien', 'chien', 3, 8, 'Le chien dort.', 1);

-- A fixed occurrence version, so the payload assertions compare against known
-- stamps rather than whatever the insert triggers happened to write.
update public.documents
set occurrences_updated_at = current_setting('test.snapshot')::timestamptz - interval '10 minutes'
where id = :'document_id'::uuid;

-- ---------------------------------------------------------------------------
-- Projection fixture. server_updated_at is set explicitly; the BEFORE trigger
-- would otherwise overwrite it with clock_timestamp().
--
-- Relative to the snapshot (S = 2026-10-27 12:00:00+00):
--   alpha, beta, zulu  live, before the snapshot          -> full page
--   edge               live, exactly at the snapshot      -> full page (<=)
--   far                live, after the snapshot           -> incremental only
--   revived            live again, after the snapshot    -> incremental only
--   mid                soft-deleted before the snapshot   -> incremental only
--   gone               live at the snapshot, deleted after-> excluded (changed
--                      after S; the incremental pull starts at S)
--   de/alpha           other language                     -> never in fr pages
--   other/fr           other tenant                       -> never visible
-- ---------------------------------------------------------------------------

alter table public.wordbook_entries disable trigger wordbook_entries_server_updated_at;

insert into public.wordbook_entries (user_id, language_code, lemma, server_updated_at, deleted_at)
values
  (:'user_id'::uuid, 'fr', 'alpha', current_setting('test.snapshot')::timestamptz - interval '3 minutes', null),
  (:'user_id'::uuid, 'fr', 'beta', current_setting('test.snapshot')::timestamptz - interval '2 minutes', null),
  (:'user_id'::uuid, 'fr', 'edge', current_setting('test.snapshot')::timestamptz, null),
  (:'user_id'::uuid, 'fr', 'zulu', current_setting('test.snapshot')::timestamptz - interval '4 minutes', null),
  (:'user_id'::uuid, 'fr', 'far', current_setting('test.snapshot')::timestamptz + interval '1 minute', null),
  (:'user_id'::uuid, 'fr', 'revived', current_setting('test.snapshot')::timestamptz + interval '2 minutes', null),
  (:'user_id'::uuid, 'fr', 'mid', current_setting('test.snapshot')::timestamptz - interval '30 seconds',
   current_setting('test.snapshot')::timestamptz - interval '30 seconds'),
  (:'user_id'::uuid, 'fr', 'gone', current_setting('test.snapshot')::timestamptz + interval '30 seconds',
   current_setting('test.snapshot')::timestamptz + interval '30 seconds'),
  (:'user_id'::uuid, 'de', 'alpha', current_setting('test.snapshot')::timestamptz - interval '1 minute', null),
  (:'other_user_id'::uuid, 'fr', 'otherword', current_setting('test.snapshot')::timestamptz - interval '1 minute', null);

-- Page-size fixture: more live rows than the 1000-row ceiling.
insert into public.wordbook_entries (user_id, language_code, lemma, server_updated_at)
select
  :'user_id'::uuid,
  'es',
  'w' || lpad(g::text, 4, '0'),
  current_setting('test.snapshot')::timestamptz - interval '1 minute'
from generate_series(1, 1005) as g;

alter table public.wordbook_entries enable trigger wordbook_entries_server_updated_at;

-- Test-only reset for the server pass/counter state. Only reachable as the
-- database owner (the test calls it after `reset role`).
create or replace function pg_temp.reset_projection(p_user_id uuid)
returns void
language sql
as $$
  delete from public.projection_sync_passes where user_id = p_user_id;
  delete from public.projection_usage where user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- Function shape and grants
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text[];
begin
  select array_agg(p.proname) into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'get_wordbook_projection_page',
      'get_document_payload',
      'get_document_content_page',
      'touch_document'
    )
    and (
      -- The page RPC is the only read path and is definer-owned; the other
      -- read/touch endpoints remain invoker-owned.
      (p.proname = 'get_wordbook_projection_page' and not p.prosecdef)
      or (p.proname <> 'get_wordbook_projection_page' and p.prosecdef)
      or not (p.proconfig @> array['search_path=public, pg_temp'])
      or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
    );
  if v_bad is not null then
    raise exception 'projection read functions are missing, definer-based, or wrongly granted: %', v_bad;
  end if;

  -- The page RPC is now the only read path; a direct PostgREST range request
  -- must not reach wordbook_entries.
  if has_table_privilege('authenticated', 'public.wordbook_entries', 'SELECT') then
    raise exception 'authenticated still has direct SELECT on wordbook_entries';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Full page: snapshot bound, live rows only, ordered, keyset by lemma
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_lemmas text[];
  v_after text[];
  v_row public.wordbook_entries%rowtype;
  v_previous text;
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_user uuid := current_setting('test.user_id')::uuid;
begin
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 100);

  if v_lemmas is distinct from array['alpha', 'beta', 'edge', 'zulu'] then
    raise exception 'full projection page for fr is %, expected {alpha,beta,edge,zulu}',
      v_lemmas;
  end if;

  -- The output order itself, not just the aggregated set. This is a replay of
  -- the first (and final) page; the server allows it idempotently.
  v_previous := null;
  for v_row in
    select * from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 100)
  loop
    if v_previous is not null and v_row.lemma <= v_previous then
      raise exception 'full projection page is not ordered by lemma: % after %',
        v_row.lemma, v_previous;
    end if;
    v_previous := v_row.lemma;
  end loop;

  if exists (
    select 1 from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 100)
    where language_code <> 'fr'
       or user_id <> v_user
       or deleted_at is not null
  ) then
    raise exception 'full fr page leaked another language, account, or a soft-deleted row';
  end if;

  -- Keyset resume: seed the server state a first page would have left, then
  -- continue strictly after the cursor.
  reset role;
  perform pg_temp.reset_projection(v_user);
  insert into public.projection_sync_passes
    (user_id, snapshot, language_code, started_at, last_cursor, previous_cursor, complete)
  values (v_user, v_snapshot, 'fr', clock_timestamp(), 'beta', 'alpha', false);
  set role authenticated;

  select array_agg(lemma order by lemma) into v_after
  from public.get_wordbook_projection_page('fr', 'beta', v_snapshot, null, 100);
  if v_after is distinct from array['edge', 'zulu'] then
    raise exception 'page after beta is %, expected {edge,zulu}', v_after;
  end if;

  -- A snapshot exactly on a row includes that row (<=, not <).
  reset role;
  perform pg_temp.reset_projection(v_user);
  set role authenticated;

  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', null, v_snapshot - interval '1 second', null, 100);
  if v_lemmas is distinct from array['alpha', 'beta', 'zulu'] then
    raise exception 'edge row was not bound by <= the snapshot: %', v_lemmas;
  end if;
end $$;

-- Other language rows are theirs alone.
reset role;
select pg_temp.reset_projection(:'user_id'::uuid);
set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_lemmas text[];
begin
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('de', null, current_setting('test.snapshot')::timestamptz, null, 100);
  if v_lemmas is distinct from array['alpha'] then
    raise exception 'de page is %, expected {alpha}', v_lemmas;
  end if;

  if exists (
    select 1 from public.get_wordbook_projection_page(
      'fr', null, null, '1970-01-01'::timestamptz, 1000
    )
    where user_id = current_setting('test.other_user_id')::uuid
       or lemma = 'otherword'
  ) then
    raise exception 'projection page read another tenant''s row';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Incremental page: includes soft-deleted rows
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.reset_projection(:'user_id'::uuid);
set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_lemmas text[];
  v_deleted int;
begin
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', null, null, '1970-01-01'::timestamptz, 100);

  if v_lemmas is distinct from array['alpha', 'beta', 'edge', 'far', 'gone', 'mid', 'revived', 'zulu'] then
    raise exception 'incremental fr page is %, expected {alpha,beta,edge,far,gone,mid,revived,zulu}', v_lemmas;
  end if;

  select count(*) into v_deleted
  from public.get_wordbook_projection_page('fr', null, null, '1970-01-01'::timestamptz, 100)
  where deleted_at is not null;
  if v_deleted <> 2 then
    raise exception 'incremental page carried % soft-deleted rows, expected 2', v_deleted;
  end if;

  -- A full page never includes a soft deletion, even one made before the
  -- snapshot.
  if exists (
    select 1 from public.get_wordbook_projection_page(
      'fr', null, current_setting('test.snapshot')::timestamptz, null, 100
    )
    where lemma in ('mid', 'gone')
  ) then
    raise exception 'full page included a soft-deleted row';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2b. Bounded incremental page: only rows after the watermark, including a
--     soft delete and a revival, excluding an unchanged row and an old delete.
-- ---------------------------------------------------------------------------

do $$
declare
  v_lemmas text[];
  v_deleted int;
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
begin
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', null, null, v_snapshot, 100);

  if v_lemmas is distinct from array['far', 'gone', 'revived'] then
    raise exception 'bounded incremental page is %, expected {far,gone,revived}', v_lemmas;
  end if;

  -- The changed row is live; the soft delete is carried with deleted_at; the
  -- revival is live again.
  select count(*) into v_deleted
  from public.get_wordbook_projection_page('fr', null, null, v_snapshot, 100)
  where deleted_at is not null;
  if v_deleted <> 1 then
    raise exception 'bounded incremental page carried % soft-deleted rows, expected 1', v_deleted;
  end if;

  if exists (
    select 1 from public.get_wordbook_projection_page('fr', null, null, v_snapshot, 100)
    where lemma in ('alpha', 'beta', 'edge', 'mid', 'zulu')
  ) then
    raise exception 'bounded incremental page returned a row at or before the watermark';
  end if;

  -- Paging inside the same watermark keeps the bound.
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', 'far', null, v_snapshot, 100);
  if v_lemmas is distinct from array['gone', 'revived'] then
    raise exception 'bounded incremental page after far is %, expected {gone,revived}', v_lemmas;
  end if;

  -- Mixing both bounds is rejected instead of silently changing the mode.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', null, v_snapshot, v_snapshot, 100);
    raise exception 'mixing p_snapshot and p_updated_since was accepted';
  exception
    when sqlstate '22023' then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Page ceiling and clamping
-- ---------------------------------------------------------------------------

do $$
declare
  v_count int;
  v_lemmas text[];
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_user uuid := current_setting('test.user_id')::uuid;
begin
  select count(*) into v_count
  from public.get_wordbook_projection_page('es', null, v_snapshot, null, 5000);
  if v_count <> 1000 then
    raise exception 'oversized p_limit returned % rows, expected the 1000-row ceiling', v_count;
  end if;

  reset role;
  perform pg_temp.reset_projection(v_user);
  set role authenticated;

  select count(*) into v_count
  from public.get_wordbook_projection_page('es', null, v_snapshot, null, null);
  if v_count <> 1000 then
    raise exception 'NULL p_limit returned % rows, expected 1000', v_count;
  end if;

  reset role;
  perform pg_temp.reset_projection(v_user);
  set role authenticated;

  select count(*) into v_count
  from public.get_wordbook_projection_page('es', null, v_snapshot, null, 3);
  if v_count <> 3 then
    raise exception 'p_limit 3 returned % rows', v_count;
  end if;

  reset role;
  perform pg_temp.reset_projection(v_user);
  set role authenticated;

  select count(*) into v_count
  from public.get_wordbook_projection_page('es', null, v_snapshot, null, 0);
  if v_count <> 1 then
    raise exception 'p_limit 0 returned % rows, expected the 1-row floor', v_count;
  end if;

  -- Seed the server cursor a previous page would have left, then continue.
  reset role;
  perform pg_temp.reset_projection(v_user);
  insert into public.projection_sync_passes
    (user_id, snapshot, language_code, started_at, last_cursor, previous_cursor, complete)
  values (v_user, v_snapshot, 'es', clock_timestamp(), 'w1000', 'w0999', false);
  set role authenticated;

  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('es', 'w1000', v_snapshot, null, 10);
  if v_lemmas is distinct from array['w1001', 'w1002', 'w1003', 'w1004', 'w1005'] then
    raise exception 'late keyset page is %, expected w1001..w1005', v_lemmas;
  end if;

  -- A NULL language is not a wildcard.
  select count(*) into v_count
  from public.get_wordbook_projection_page(null, null, v_snapshot, null, 100);
  if v_count <> 0 then
    raise exception 'a NULL language returned % rows', v_count;
  end if;
end $$;

-- An authenticated request with no subject sees no rows, and a touch without a
-- subject is rejected.
select set_config('request.jwt.claim.sub', '', false);
do $$
declare
  v_touch_denied boolean := false;
begin
  if exists (
    select 1 from public.get_wordbook_projection_page(
      'fr', null, current_setting('test.snapshot')::timestamptz, null, 100
    )
  ) then
    raise exception 'an unauthenticated subject read projection rows';
  end if;

  begin
    perform public.touch_document(current_setting('test.document_id')::uuid, now());
  exception
    when raise_exception then v_touch_denied := true;
  end;
  if not v_touch_denied then
    raise exception 'a no-subject touch was accepted';
  end if;
end $$;
select set_config('request.jwt.claim.sub', :'user_id', false);

reset role;

-- ---------------------------------------------------------------------------
-- 4. get_document_payload
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_payload jsonb;
  v_document public.documents%rowtype;
  v_occurrences jsonb;
  v_expected jsonb;
  v_empty jsonb;
begin
  select * into v_document from public.documents
  where id = current_setting('test.document_id')::uuid;

  v_payload := public.get_document_payload(v_document.id);

  if v_payload is null then
    raise exception 'get_document_payload returned NULL for the owner';
  end if;
  if v_payload->>'rawText' is distinct from v_document.raw_text then
    raise exception 'payload rawText is %, expected %', v_payload->>'rawText', v_document.raw_text;
  end if;
  if (v_payload->>'contentUpdatedAt')::timestamptz
     is distinct from v_document.content_updated_at then
    raise exception 'payload contentUpdatedAt is %, expected %',
      v_payload->>'contentUpdatedAt', v_document.content_updated_at;
  end if;
  if (v_payload->>'occurrencesUpdatedAt')::timestamptz
     is distinct from v_document.occurrences_updated_at then
    raise exception 'payload occurrencesUpdatedAt is %, expected %',
      v_payload->>'occurrencesUpdatedAt', v_document.occurrences_updated_at;
  end if;

  v_occurrences := v_payload->'occurrences';
  if jsonb_typeof(v_occurrences) <> 'array' or jsonb_array_length(v_occurrences) <> 2 then
    raise exception 'payload occurrences are %, expected 2 rows', v_occurrences;
  end if;

  v_expected := jsonb_build_array(
    jsonb_build_object(
      'languageCode', 'fr', 'lemma', 'chat', 'surface', 'chat',
      'charStart', 3, 'charEnd', 7, 'sentence', 'Le chat dort.', 'occurrencesCount', 3
    ),
    jsonb_build_object(
      'languageCode', 'fr', 'lemma', 'chat', 'surface', 'chats',
      'charStart', 19, 'charEnd', 24, 'sentence', 'Le chat mange.', 'occurrencesCount', 3
    )
  );
  if v_occurrences is distinct from v_expected then
    raise exception 'payload occurrences are not ordered rows: %', v_occurrences;
  end if;

  -- Another tenant's document is indistinguishable from a missing one.
  if public.get_document_payload(current_setting('test.other_document_id')::uuid) is not null then
    raise exception 'get_document_payload returned another tenant''s document';
  end if;
  if public.get_document_payload(gen_random_uuid()) is not null then
    raise exception 'get_document_payload returned a missing document';
  end if;

  -- A document with no occurrences has an empty payload array, not NULL.
  v_empty := public.get_document_payload(current_setting('test.empty_document_id')::uuid);
  if v_empty is null then
    raise exception 'get_document_payload returned NULL for an empty document';
  end if;
  if v_empty->>'rawText' is distinct from 'No words here.' then
    raise exception 'empty document payload text is %', v_empty->>'rawText';
  end if;
  if v_empty->'occurrences' is distinct from '[]'::jsonb then
    raise exception 'empty document payload occurrences are %', v_empty->'occurrences';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4b. get_document_content_page — paged, resumable text under the soft cap
-- ---------------------------------------------------------------------------

do $$
declare
  v_document public.documents%rowtype;
  v_expected_version timestamptz;
  v_page jsonb;
  v_text text := '';
  v_offset int := 0;
  v_guard int := 0;
  v_single jsonb;
begin
  select * into v_document from public.documents
  where id = current_setting('test.document_id')::uuid;
  v_expected_version := v_document.content_updated_at;

  -- Assemble the text the way the client does: page, append, advance.
  loop
    v_page := public.get_document_content_page(v_document.id, v_offset, 5);
    if v_page is null then
      raise exception 'get_document_content_page returned NULL for the owner';
    end if;
    if (v_page->>'contentUpdatedAt')::timestamptz is distinct from v_expected_version then
      raise exception 'content page version is %, expected %',
        v_page->>'contentUpdatedAt', v_expected_version;
    end if;
    if (v_page->>'charCount')::int <> char_length(v_document.raw_text) then
      raise exception 'content page charCount is %, expected %',
        v_page->>'charCount', char_length(v_document.raw_text);
    end if;

    v_text := v_text || coalesce(v_page->>'rawText', '');
    v_offset := (v_page->>'nextOffset')::int;
    exit when (v_page->>'done')::boolean;

    v_guard := v_guard + 1;
    if v_guard > 50 then
      raise exception 'paged content did not finish in 50 pages';
    end if;
  end loop;

  if v_text is distinct from v_document.raw_text then
    raise exception 'paged content assembled to %, expected %', v_text, v_document.raw_text;
  end if;
  if v_offset <> char_length(v_document.raw_text) then
    raise exception 'final nextOffset is %, expected the text length', v_offset;
  end if;

  -- A NULL p_max_chars / oversized limit is bounded; a zero limit is one char.
  v_single := public.get_document_content_page(v_document.id, null, null);
  if v_single->>'rawText' is distinct from v_document.raw_text then
    raise exception 'default page did not return the whole small document';
  end if;
  if not (v_single->>'done')::boolean or (v_single->>'nextOffset')::int <> char_length(v_document.raw_text) then
    raise exception 'default page did not report done/nextOffset: %', v_single;
  end if;

  v_single := public.get_document_content_page(v_document.id, 0, 0);
  if v_single->>'rawText' is distinct from left(v_document.raw_text, 1) then
    raise exception 'p_max_chars 0 returned %, expected one character', v_single->>'rawText';
  end if;

  -- An offset past the end is an empty, done page — a retry never loops.
  v_single := public.get_document_content_page(v_document.id, 1000, 5);
  if v_single->>'rawText' is distinct from '' or not (v_single->>'done')::boolean then
    raise exception 'past-the-end page was %', v_single;
  end if;

  -- An oversized p_max_chars is clamped, not rejected: this small document
  -- comes back whole in one page.
  v_single := public.get_document_content_page(v_document.id, 0, 2147483647);
  if v_single->>'rawText' is distinct from v_document.raw_text
     or not (v_single->>'done')::boolean then
    raise exception 'oversized p_max_chars page was %', v_single;
  end if;

  -- A page smaller than the document returns exactly that page, not the text.
  v_single := public.get_document_content_page(
    current_setting('test.empty_document_id')::uuid, 0, 5
  );
  if v_single->>'rawText' is distinct from left('No words here.', 5)
     or (v_single->>'done')::boolean then
    raise exception 'small page of a non-empty document returned %', v_single;
  end if;

  -- Another tenant's document and a missing one are indistinguishable from NULL.
  if public.get_document_content_page(
    current_setting('test.other_document_id')::uuid, 0, 5
  ) is not null then
    raise exception 'get_document_content_page returned another tenant''s document';
  end if;
  if public.get_document_content_page(gen_random_uuid(), 0, 5) is not null then
    raise exception 'get_document_content_page returned a missing document';
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 5. touch_document
-- ---------------------------------------------------------------------------

create temp table touch_other_before as
select to_jsonb(d) as j
from public.documents d
where d.id = current_setting('test.other_document_id')::uuid;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_document_id uuid := current_setting('test.document_id')::uuid;
  v_before public.documents%rowtype;
  v_after public.documents%rowtype;
  v_opened timestamptz := now() + interval '1 hour';
  v_later timestamptz := now() + interval '2 hours';
  v_after_later timestamptz;
begin
  select * into v_before from public.documents where id = v_document_id;

  perform public.touch_document(v_document_id, v_opened);

  select * into v_after from public.documents where id = v_document_id;

  if v_after.last_opened_at is distinct from v_opened then
    raise exception 'touch_document set last_opened_at to %, expected %',
      v_after.last_opened_at, v_opened;
  end if;

  -- Only last_opened_at and the server watermark may differ. Content, versions,
  -- title, folder, trash state, and updated_at must be untouched.
  if (to_jsonb(v_after) - 'last_opened_at' - 'server_updated_at')
     is distinct from (to_jsonb(v_before) - 'last_opened_at' - 'server_updated_at') then
    raise exception 'touch_document changed fields other than last_opened_at: % -> %',
      to_jsonb(v_before), to_jsonb(v_after);
  end if;
  if v_after.content_updated_at is distinct from v_before.content_updated_at
     or v_after.occurrences_updated_at is distinct from v_before.occurrences_updated_at
     or v_after.raw_text is distinct from v_before.raw_text
     or v_after.updated_at is distinct from v_before.updated_at then
    raise exception 'touch_document claimed a content or occurrence change';
  end if;
  if v_after.server_updated_at < v_before.server_updated_at then
    raise exception 'touch_document moved the metadata watermark backwards';
  end if;

  -- An older client clock cannot undo a later open, and a non-newer touch is a
  -- true no-op: it must not advance the metadata watermark either.
  perform public.touch_document(v_document_id, v_later);
  select server_updated_at into v_after_later
  from public.documents where id = v_document_id;

  perform public.touch_document(v_document_id, v_opened);
  perform public.touch_document(v_document_id, v_later);
  select * into v_after from public.documents where id = v_document_id;
  if v_after.last_opened_at is distinct from v_later then
    raise exception 'touch_document moved last_opened_at backwards to %', v_after.last_opened_at;
  end if;
  if v_after.server_updated_at is distinct from v_after_later then
    raise exception 'a non-newer touch advanced server_updated_at (% -> %)',
      v_after_later, v_after.server_updated_at;
  end if;

  -- Another tenant's document is rejected and untouched.
  begin
    perform public.touch_document(current_setting('test.other_document_id')::uuid, v_opened);
    raise exception 'touch_document accepted another tenant''s document';
  exception
    when sqlstate 'P0002' then null;
  end;

  begin
    perform public.touch_document(gen_random_uuid(), v_opened);
    raise exception 'touch_document accepted a missing document';
  exception
    when sqlstate 'P0002' then null;
  end;
end $$;

reset role;

do $$
declare
  v_other public.documents%rowtype;
  v_before jsonb;
begin
  select j into v_before from touch_other_before;
  select * into v_other from public.documents
  where id = current_setting('test.other_document_id')::uuid;
  if to_jsonb(v_other) is distinct from v_before then
    raise exception 'a rejected touch changed the other tenant''s document';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. anon is denied on every endpoint
-- ---------------------------------------------------------------------------

set role anon;

do $$
begin
  begin
    perform public.get_wordbook_projection_page('fr', null, null, null, 1);
    raise exception 'anon executed get_wordbook_projection_page';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.get_document_payload(gen_random_uuid());
    raise exception 'anon executed get_document_payload';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.get_document_content_page(gen_random_uuid(), 0, 5);
    raise exception 'anon executed get_document_content_page';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.touch_document(gen_random_uuid(), now());
    raise exception 'anon executed touch_document';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 7. Cleanup
--
-- The fixture seeds word_occurrences directly. Leaving them behind would let a
-- later suite's global backfill create projection rows for this account, so
-- remove the test users (documents, occurrences, and projection rows cascade).
-- ---------------------------------------------------------------------------

delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid);
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid);
