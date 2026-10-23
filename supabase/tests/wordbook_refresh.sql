-- Wordbook projection refresh: occurrence diff, word state, purge, contention.
--
-- Run after `npx supabase db reset`:
--   docker exec -i supabase_db_translator psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/wordbook_refresh.sql
--
-- Setup and projection assertions run as the database owner. Writes that a
-- client performs (replace_word_occurrences, direct document delete,
-- word_states via RLS) run as `authenticated` with request.jwt.claim.sub set,
-- so the trigger and RPC boundaries are exercised as a client hits them.

\set user_id '00000000-0000-4000-8000-00000000e001'
\set other_user_id '00000000-0000-4000-8000-00000000e002'
\set cascade_user_id '00000000-0000-4000-8000-00000000e003'

-- Clean any leftover run.
select set_config('test.user_id', :'user_id', false);
select set_config('test.other_user_id', :'other_user_id', false);
select set_config('test.cascade_user_id', :'cascade_user_id', false);

delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid, :'cascade_user_id'::uuid);
do $$
begin
  -- The queue is created by the migration under test; the failure run of this
  -- file must still reach its assertions.
  if to_regclass('public.wordbook_refresh_queue') is not null then
    delete from public.wordbook_refresh_queue
    where user_id in (
      current_setting('test.user_id')::uuid,
      current_setting('test.other_user_id')::uuid,
      current_setting('test.cascade_user_id')::uuid
    );
  end if;
end $$;
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid, :'cascade_user_id'::uuid);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  (:'user_id'::uuid, 'authenticated', 'authenticated', 'refresh-a@example.test', now(), now(), now()),
  (:'other_user_id'::uuid, 'authenticated', 'authenticated', 'refresh-b@example.test', now(), now(), now());

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'first', 'fr', 'Le chat dort. Le chat mange. Le chien dort.')
returning id as d1 \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'second', 'fr', 'Un chat noir.')
returning id as d2 \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'third', 'fr', 'La lune brille.')
returning id as d3 \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'fourth', 'fr', 'Le soleil brille.')
returning id as d4 \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'other_user_id'::uuid, 'other tenant', 'fr', 'Le chien dort.')
returning id as d_other \gset

select set_config('test.d1', :'d1', false);
select set_config('test.d2', :'d2', false);
select set_config('test.d3', :'d3', false);
select set_config('test.d4', :'d4', false);
select set_config('test.d_other', :'d_other', false);
select set_config('test.user_id', :'user_id', false);
select set_config('test.other_user_id', :'other_user_id', false);

-- The other tenant's row is seeded through the backfill, then checked not to
-- change for the rest of the run.
insert into public.word_occurrences
  (user_id, document_id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count)
values
  (:'other_user_id'::uuid, :'d_other'::uuid, 'fr', 'chien', 'chien', 3, 8, 'Le chien dort.', 1);

select public.backfill_wordbook_entries();

-- A state for chat exists before the occurrences, so the first refresh also
-- hydrates the state fields.
insert into public.word_states
  (user_id, language_code, lemma, status, seen_count, first_seen_at, last_seen_at,
   is_favorite, favorite_updated_at, star_angle, star_color,
   known_presses, unsure_presses, unknown_presses, note, note_updated_at)
values
  (:'user_id'::uuid, 'fr', 'chat', 'known', 4, now() - interval '2 days', now(),
   true, now() - interval '1 day', 30, '#ff0000', 1, 2, 3, 'first note', now() - interval '1 hour');

-- Seed the user's documents through the RPC under test, not through direct
-- inserts: this exercises the occurrence refresh path from the start.
set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

select public.replace_word_occurrences(:'d1', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Le chat dort.","occurrences_count":3},
  {"language_code":"fr","lemma":"chat","surface":"chats","char_start":19,"char_end":24,"sentence":"Le chat mange.","occurrences_count":3},
  {"language_code":"fr","lemma":"chien","surface":"chien","char_start":0,"char_end":5,"sentence":"Le chien dort.","occurrences_count":1}
]'::jsonb);

select public.replace_word_occurrences(:'d2', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Un chat noir.","occurrences_count":2}
]'::jsonb);

select public.replace_word_occurrences(:'d3', '[
  {"language_code":"fr","lemma":"lune","surface":"lune","char_start":3,"char_end":7,"sentence":"La lune brille.","occurrences_count":4}
]'::jsonb);

select public.replace_word_occurrences(:'d4', '[
  {"language_code":"fr","lemma":"soleil","surface":"soleil","char_start":3,"char_end":9,"sentence":"Le soleil brille.","occurrences_count":1}
]'::jsonb);

reset role;

-- Snapshot rows that no later operation is allowed to touch.
create temp table untouched as
select user_id, language_code, lemma, to_jsonb(w) as j
from public.wordbook_entries w
where (user_id = current_setting('test.user_id')::uuid and lemma in ('lune', 'soleil'))
   or user_id = current_setting('test.other_user_id')::uuid;

-- ---------------------------------------------------------------------------
-- Trigger and function shape
-- ---------------------------------------------------------------------------

do $$
declare
  v_missing text[];
  v_def text;
  v_bad text[];
begin
  -- All three word_states refresh triggers are statement-level (tgtype bit 1
  -- is the ROW flag) and carry the transition table they read.
  select array_agg(expected.tgname) into v_missing
  from (values
    ('word_states_refresh_insert', 'new_rows', null),
    ('word_states_refresh_update', 'new_rows', 'old_rows'),
    ('word_states_refresh_delete', null, 'old_rows')
  ) as expected(tgname, new_table, old_table)
  where not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.word_states'::regclass
      and not t.tgisinternal
      and t.tgname = expected.tgname
      and (t.tgtype & 1) = 0
      and t.tgnewtable is not distinct from expected.new_table
      and t.tgoldtable is not distinct from expected.old_table
  );
  if v_missing is not null then
    raise exception 'word_states refresh triggers are missing or not statement-level with transition tables: %', v_missing;
  end if;

  -- The document purge paths are triggers too: a row trigger captures the
  -- lemmas, a statement trigger drains the queue.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.documents'::regclass
      and tgname = 'documents_enqueue_wordbook_purge'
      and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.documents'::regclass
      and tgname = 'documents_drain_wordbook_purge'
      and not tgisinternal
      and (tgtype & 1) = 0
  ) then
    raise exception 'document purge triggers are missing';
  end if;

  -- Internal refresh functions are definer with a fixed search_path and are
  -- not executable by clients; the client RPCs still are.
  select array_agg(p.proname) into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'refresh_wordbook_pairs',
      'refresh_wordbook_entries',
      'refresh_wordbook_entry',
      'refresh_wordbook_entries_from_states',
      'enqueue_wordbook_purge',
      'drain_wordbook_refresh_queue',
      'drain_wordbook_purge_queue'
    )
    and (
      not p.prosecdef
      or not (p.proconfig @> array['search_path=public, pg_temp'])
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    );
  if v_bad is not null then
    raise exception 'internal refresh functions are not locked down: %', v_bad;
  end if;

  if not has_function_privilege('authenticated', 'public.delete_document(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.replace_word_occurrences(uuid, jsonb)', 'EXECUTE') = false
     or has_function_privilege('anon', 'public.replace_word_occurrences(uuid, jsonb)', 'EXECUTE') then
    raise exception 'RPC execute grants are wrong';
  end if;

  -- refresh_wordbook_pairs must order the affected set deterministically.
  select pg_get_functiondef('public.refresh_wordbook_pairs(jsonb)'::regprocedure) into v_def;
  if v_def not like '%order by r.user_id, r.language_code, r.lemma%' then
    raise exception 'refresh_wordbook_pairs does not order by (user, language, lemma)';
  end if;
end $$;

-- A wordless document's first empty push claims its hash but is not an
-- occurrence change.
insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'wordless', 'fr', 'x')
returning id as d0 \gset
select set_config('test.d0', :'d0', false);

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
select public.replace_word_occurrences(:'d0', '[]'::jsonb);
reset role;

do $$
declare
  v_hash text;
  v_occ timestamptz;
begin
  select occurrences_hash, occurrences_updated_at into v_hash, v_occ
  from public.documents where id = current_setting('test.d0')::uuid;
  if v_hash is distinct from public.word_occurrence_hash('[]'::jsonb) then
    raise exception 'empty push did not set the canonical empty hash';
  end if;
  if v_occ is not null then
    raise exception 'empty first push claimed occurrences_updated_at without an occurrence change';
  end if;
  if exists (
    select 1 from public.wordbook_entries
    where user_id = current_setting('test.user_id')::uuid
      and lemma in (select lemma from public.word_occurrences
                    where document_id = current_setting('test.d0')::uuid)
  ) then
    raise exception 'empty document created projection rows';
  end if;
end $$;

-- The required multi-lemma wrapper accepts a set and is a no-op when the
-- source has not changed.
create temp table before_wrapper as
select to_jsonb(w) as j
from public.wordbook_entries w
where w.user_id = current_setting('test.user_id')::uuid;

select public.refresh_wordbook_entries(
  current_setting('test.user_id')::uuid,
  'fr',
  array['chat', 'chien', 'lune']
);

do $$
begin
  if exists (
    select 1 from before_wrapper b
    where not exists (
      select 1 from public.wordbook_entries w where to_jsonb(w) = b.j
    )
  ) or exists (
    select 1 from public.wordbook_entries w
    where w.user_id = current_setting('test.user_id')::uuid
      and not exists (
        select 1 from before_wrapper b where b.j = to_jsonb(w)
      )
  ) then
    raise exception 'a no-op multi-lemma wrapper call rewrote projection rows';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- NULL-hash, non-empty, unchanged first push
--
-- This is the deployment shape of every document that existed before Task 1
-- added occurrences_hash: rows and projection exist, the hash is NULL. The
-- first push that matches the stored rows initializes the hash but must not
-- call refresh, move occurrences_updated_at, rewrite an occurrence row, or
-- touch the projection.
-- ---------------------------------------------------------------------------

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'legacy hash', 'fr', 'L''ancien texte. L''ancienne version.')
returning id as d_legacy \gset
select set_config('test.d_legacy', :'d_legacy', false);

insert into public.word_occurrences
  (user_id, document_id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count)
values
  (:'user_id'::uuid, :'d_legacy'::uuid, 'fr', 'ancien', 'ancien', 2, 8, 'L''ancien texte.', 3),
  (:'user_id'::uuid, :'d_legacy'::uuid, 'fr', 'ancienne', 'ancienne', 10, 18, 'L''ancienne version.', 3);

-- Build the projection the way the Task 3 deployment backfill would have.
select public.refresh_wordbook_entries(
  current_setting('test.user_id')::uuid,
  'fr',
  array['ancien', 'ancienne']
);

do $$
begin
  if (select occurrences_hash from public.documents
      where id = current_setting('test.d_legacy')::uuid) is not null then
    raise exception 'legacy fixture unexpectedly has an occurrences_hash';
  end if;
  if (select occurrences_updated_at from public.documents
      where id = current_setting('test.d_legacy')::uuid) is not null then
    raise exception 'legacy fixture unexpectedly has occurrences_updated_at';
  end if;
  if (select occurrence_count from public.wordbook_entries
      where user_id = current_setting('test.user_id')::uuid and lemma = 'ancien') <> 3 then
    raise exception 'legacy fixture projection is wrong';
  end if;
end $$;

create temp table before_null_hash as
select
  (select to_jsonb(d) from public.documents d
   where d.id = current_setting('test.d_legacy')::uuid) as document,
  (select jsonb_agg(to_jsonb(w) order by w.lemma) from public.wordbook_entries w
   where w.user_id = current_setting('test.user_id')::uuid
     and w.lemma in ('ancien', 'ancienne')) as entries,
  (select jsonb_agg(
            jsonb_build_object('xmin', o.xmin::text, 'row', to_jsonb(o))
            order by o.id)
   from public.word_occurrences o
   where o.document_id = current_setting('test.d_legacy')::uuid) as occurrences;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

select public.replace_word_occurrences(:'d_legacy', '[
  {"language_code":"fr","lemma":"ancienne","surface":"ancienne","char_start":10,"char_end":18,"sentence":"L''ancienne version.","occurrences_count":3},
  {"language_code":"fr","lemma":"ancien","surface":"ancien","char_start":2,"char_end":8,"sentence":"L''ancien texte.","occurrences_count":3}
]'::jsonb);

reset role;

do $$
declare
  v_before record;
  v_doc public.documents%rowtype;
  v_entries jsonb;
  v_occurrences jsonb;
  v_payload jsonb := '[
    {"language_code":"fr","lemma":"ancien","surface":"ancien","char_start":2,"char_end":8,"sentence":"L''ancien texte.","occurrences_count":3},
    {"language_code":"fr","lemma":"ancienne","surface":"ancienne","char_start":10,"char_end":18,"sentence":"L''ancienne version.","occurrences_count":3}
  ]'::jsonb;
begin
  select * into v_before from before_null_hash;

  select * into v_doc from public.documents
  where id = current_setting('test.d_legacy')::uuid;

  if v_doc.occurrences_hash is null then
    raise exception 'unchanged non-empty first push did not initialize the hash';
  end if;
  if v_doc.occurrences_hash is distinct from public.word_occurrence_hash(v_payload) then
    raise exception 'unchanged non-empty first push stored the wrong hash';
  end if;

  -- The hash initialization is a document metadata write only. The occurrence
  -- watermark must not move, and neither may content.
  if v_doc.occurrences_updated_at is not null then
    raise exception 'unchanged non-empty first push claimed occurrences_updated_at';
  end if;
  if to_jsonb(v_doc)->>'content_updated_at'
     is distinct from v_before.document->>'content_updated_at' then
    raise exception 'unchanged non-empty first push changed content_updated_at';
  end if;

  -- No occurrence row was deleted, re-inserted, or updated (xmin proves it).
  select jsonb_agg(
           jsonb_build_object('xmin', o.xmin::text, 'row', to_jsonb(o))
           order by o.id)
  into v_occurrences
  from public.word_occurrences o
  where o.document_id = current_setting('test.d_legacy')::uuid;
  if v_occurrences is distinct from v_before.occurrences then
    raise exception 'unchanged non-empty first push rewrote occurrence rows';
  end if;

  -- The projection rows are byte-identical, watermarks included.
  select jsonb_agg(to_jsonb(w) order by w.lemma)
  into v_entries
  from public.wordbook_entries w
  where w.user_id = current_setting('test.user_id')::uuid
    and w.lemma in ('ancien', 'ancienne');
  if v_entries is distinct from v_before.entries then
    raise exception 'unchanged non-empty first push rewrote the projection: % -> %',
      v_before.entries, v_entries;
  end if;
end $$;

-- The initialized hash makes an immediate identical re-push a full no-op.
create temp table after_null_hash as
select
  (select to_jsonb(d) from public.documents d
   where d.id = current_setting('test.d_legacy')::uuid) as document;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
select public.replace_word_occurrences(:'d_legacy', '[
  {"language_code":"fr","lemma":"ancien","surface":"ancien","char_start":2,"char_end":8,"sentence":"L''ancien texte.","occurrences_count":3},
  {"language_code":"fr","lemma":"ancienne","surface":"ancienne","char_start":10,"char_end":18,"sentence":"L''ancienne version.","occurrences_count":3}
]'::jsonb);
reset role;

do $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  select document into v_before from after_null_hash;
  select to_jsonb(d) into v_after from public.documents d
  where d.id = current_setting('test.d_legacy')::uuid;
  if v_after is distinct from v_before then
    raise exception 'identical re-push after hash initialization changed the document';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Seeded projection: deduped counts, contexts, and hydrated state.
-- ---------------------------------------------------------------------------

do $$
declare
  v_chat public.wordbook_entries%rowtype;
  v_lune public.wordbook_entries%rowtype;
  v_d1 uuid := current_setting('test.d1')::uuid;
  v_d2 uuid := current_setting('test.d2')::uuid;
begin
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if not found then
    raise exception 'first refresh did not create (fr, chat)';
  end if;
  if v_chat.occurrence_count <> 5 or v_chat.document_count <> 2 then
    raise exception '(fr, chat) counts are %/%, expected 5/2',
      v_chat.occurrence_count, v_chat.document_count;
  end if;
  if v_chat.surfaces is distinct from array['chat', 'chats'] then
    raise exception '(fr, chat) surfaces are %', v_chat.surfaces;
  end if;
  if jsonb_array_length(v_chat.contexts) <> 3 then
    raise exception '(fr, chat) has % contexts, expected 3', jsonb_array_length(v_chat.contexts);
  end if;
  if not v_chat.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_d1, 'sentence', 'Le chat dort.')
     )
     or not v_chat.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_d1, 'sentence', 'Le chat mange.')
     )
     or not v_chat.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_d2, 'sentence', 'Un chat noir.')
     ) then
    raise exception '(fr, chat) contexts are wrong: %', v_chat.contexts;
  end if;
  if v_chat.status <> 'known' or v_chat.seen_count <> 4 or v_chat.note <> 'first note'
     or not v_chat.is_favorite or v_chat.known_presses <> 1
     or v_chat.unsure_presses <> 2 or v_chat.unknown_presses <> 3 then
    raise exception '(fr, chat) did not hydrate word_states: %', v_chat;
  end if;

  -- Case 7 seed: lune has no word_states row.
  select * into v_lune from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'lune';
  if not found then
    raise exception 'first refresh did not create (fr, lune)';
  end if;
  if v_lune.status is not null
     or v_lune.is_favorite
     or v_lune.star_angle <> 0
     or v_lune.star_color <> '#eab308'
     or v_lune.seen_count <> 1
     or v_lune.first_seen_at is not null
     or v_lune.last_seen_at is not null
     or v_lune.favorite_updated_at is not null
     or v_lune.known_presses <> 0
     or v_lune.unsure_presses <> 0
     or v_lune.unknown_presses <> 0
     or v_lune.note is not null
     or v_lune.note_updated_at is not null then
    raise exception 'a state-less entry did not use null/default state fields: %', v_lune;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Identical re-push short-circuits: no projection write, no timestamp.
-- ---------------------------------------------------------------------------

create temp table before_noop as
select
  (select to_jsonb(w) from public.wordbook_entries w
   where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chat') as chat,
  (select occurrences_updated_at from public.documents
   where id = current_setting('test.d1')::uuid) as occurrences_updated_at;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

select public.replace_word_occurrences(:'d1', '[
  {"language_code":"fr","lemma":"chat","surface":"chats","char_start":19,"char_end":24,"sentence":"Le chat mange.","occurrences_count":3},
  {"language_code":"fr","lemma":"chien","surface":"chien","char_start":0,"char_end":5,"sentence":"Le chien dort.","occurrences_count":1},
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Le chat dort.","occurrences_count":3}
]'::jsonb);

reset role;

do $$
declare
  v_before record;
  v_chat jsonb;
  v_occ timestamptz;
begin
  select * into v_before from before_noop;
  select to_jsonb(w) into v_chat from public.wordbook_entries w
  where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chat';
  select occurrences_updated_at into v_occ from public.documents
  where id = current_setting('test.d1')::uuid;

  if v_chat is distinct from v_before.chat then
    raise exception 'reordered identical push rewrote the projection row';
  end if;
  if v_occ is distinct from v_before.occurrences_updated_at then
    raise exception 'no-op push advanced occurrences_updated_at';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Real diff: affected entries change, unrelated rows do not.
-- ---------------------------------------------------------------------------

create temp table before_diff as
select
  (select occurrences_updated_at from public.documents
   where id = current_setting('test.d1')::uuid) as d1_occ,
  (select occurrences_updated_at from public.documents
   where id = current_setting('test.d3')::uuid) as d3_occ,
  (select to_jsonb(w) from public.wordbook_entries w
   where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chien') as chien;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

select public.replace_word_occurrences(:'d1', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Le chat dort encore.","occurrences_count":4},
  {"language_code":"fr","lemma":"oiseau","surface":"oiseau","char_start":10,"char_end":16,"sentence":"Un oiseau vole.","occurrences_count":1}
]'::jsonb);

reset role;

do $$
declare
  v_chat public.wordbook_entries%rowtype;
  v_chien public.wordbook_entries%rowtype;
  v_oiseau public.wordbook_entries%rowtype;
  v_before record;
  v_d1 uuid := current_setting('test.d1')::uuid;
  v_d2 uuid := current_setting('test.d2')::uuid;
  v_j jsonb;
begin
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if v_chat.occurrence_count <> 6 or v_chat.document_count <> 2 then
    raise exception '(fr, chat) counts after diff are %/%, expected 6/2',
      v_chat.occurrence_count, v_chat.document_count;
  end if;
  if v_chat.surfaces is distinct from array['chat'] then
    raise exception '(fr, chat) kept a removed surface: %', v_chat.surfaces;
  end if;
  if jsonb_array_length(v_chat.contexts) <> 2 then
    raise exception '(fr, chat) has % contexts after diff, expected 2', jsonb_array_length(v_chat.contexts);
  end if;
  if not v_chat.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_d1, 'sentence', 'Le chat dort encore.')
     )
     or not v_chat.contexts @> jsonb_build_array(
       jsonb_build_object('documentId', v_d2, 'sentence', 'Un chat noir.')
     ) then
    raise exception '(fr, chat) contexts after diff are wrong: %', v_chat.contexts;
  end if;

  -- chien lost its only occurrence: soft-deleted, never hard-deleted.
  select * into v_chien from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chien';
  if not found then
    raise exception 'removed lemma entry was hard-deleted';
  end if;
  if v_chien.deleted_at is null then
    raise exception 'removed lemma was not soft-deleted';
  end if;
  if v_chien.occurrence_count <> 0 or v_chien.document_count <> 0
     or v_chien.surfaces <> '{}' or v_chien.contexts <> '[]'::jsonb then
    raise exception 'soft-deleted entry kept a live payload: %', v_chien;
  end if;

  select * into v_oiseau from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'oiseau';
  if not found or v_oiseau.deleted_at is not null
     or v_oiseau.occurrence_count <> 1 or v_oiseau.document_count <> 1 then
    raise exception 'new lemma was not projected: %', v_oiseau;
  end if;

  select * into v_before from before_diff;
  if (select occurrences_updated_at from public.documents where id = v_d1)
     <= v_before.d1_occ then
    raise exception 'real occurrence change did not advance occurrences_updated_at';
  end if;
  if (select occurrences_updated_at from public.documents
      where id = current_setting('test.d3')::uuid)
     is distinct from v_before.d3_occ then
    raise exception 'an unrelated document occurrence timestamp changed';
  end if;

  -- Untouched rows (lune, soleil, other tenant) are byte-identical.
  for v_j in
    select j from untouched
    where (user_id = current_setting('test.user_id')::uuid and lemma in ('lune', 'soleil'))
       or user_id = current_setting('test.other_user_id')::uuid
  loop
    if not exists (
      select 1 from public.wordbook_entries w
      where (w.user_id = current_setting('test.user_id')::uuid and w.lemma in ('lune', 'soleil')
             or w.user_id = current_setting('test.other_user_id')::uuid)
        and to_jsonb(w) = v_j
    ) then
      raise exception 'an unrelated projection row changed: %', v_j;
    end if;
  end loop;
end $$;

-- `chien` is refreshed by later operations too; it must stay exactly dead.
create temp table dead_chien as
select to_jsonb(w) as j from public.wordbook_entries w
where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chien';

-- ---------------------------------------------------------------------------
-- 4. Replace with no rows: soft-delete with a fresh timestamp.
--   5. Re-add: revive.
-- ---------------------------------------------------------------------------

create temp table before_empty as
select
  (select to_jsonb(w) from public.wordbook_entries w
   where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'oiseau') as oiseau,
  (select occurrences_updated_at from public.documents
   where id = current_setting('test.d1')::uuid) as d1_occ;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
select public.replace_word_occurrences(:'d1', '[]'::jsonb);
reset role;

do $$
declare
  v_before record;
  v_oiseau public.wordbook_entries%rowtype;
  v_chat public.wordbook_entries%rowtype;
  v_d2 uuid := current_setting('test.d2')::uuid;
begin
  select * into v_before from before_empty;
  select * into v_oiseau from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'oiseau';
  if v_oiseau.deleted_at is null then
    raise exception 'empty replacement did not soft-delete the entry';
  end if;
  if v_oiseau.server_updated_at <= (v_before.oiseau->>'server_updated_at')::timestamptz then
    raise exception 'soft delete did not advance server_updated_at (% <= %)',
      v_oiseau.server_updated_at, (v_before.oiseau->>'server_updated_at')::timestamptz;
  end if;
  if (select occurrences_updated_at from public.documents
      where id = current_setting('test.d1')::uuid) <= v_before.d1_occ then
    raise exception 'empty replacement did not advance occurrences_updated_at';
  end if;

  -- The shared chat entry keeps only the second document.
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if v_chat.occurrence_count <> 2 or v_chat.document_count <> 1 then
    raise exception 'shared lemma after empty replacement is %/%', v_chat.occurrence_count, v_chat.document_count;
  end if;
  if v_chat.contexts <> jsonb_build_array(
       jsonb_build_object('documentId', v_d2, 'sentence', 'Un chat noir.')
     ) then
    raise exception 'shared lemma kept stale contexts: %', v_chat.contexts;
  end if;

  -- An already-dead entry is not rewritten by a later refresh.
  if (select to_jsonb(w) from public.wordbook_entries w
      where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chien')
     is distinct from (select j from dead_chien) then
    raise exception 'a later refresh rewrote an already-soft-deleted entry';
  end if;
end $$;

-- Re-add chat and chien in the same document.
set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
select public.replace_word_occurrences(:'d1', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Le chat revient.","occurrences_count":2},
  {"language_code":"fr","lemma":"chien","surface":"chien","char_start":0,"char_end":5,"sentence":"Le chien revient.","occurrences_count":1}
]'::jsonb);
reset role;

do $$
declare
  v_chien public.wordbook_entries%rowtype;
  v_chat public.wordbook_entries%rowtype;
  v_oiseau public.wordbook_entries%rowtype;
  v_d1 uuid := current_setting('test.d1')::uuid;
  v_d2 uuid := current_setting('test.d2')::uuid;
begin
  select * into v_chien from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chien';
  if v_chien.deleted_at is not null then
    raise exception 'reappearing lemma was not revived';
  end if;
  if v_chien.occurrence_count <> 1 or v_chien.document_count <> 1 then
    raise exception 'revived entry counts are %/%', v_chien.occurrence_count, v_chien.document_count;
  end if;
  if v_chien.contexts <> jsonb_build_array(
       jsonb_build_object('documentId', v_d1, 'sentence', 'Le chien revient.')
     ) then
    raise exception 'revived entry has wrong contexts: %', v_chien.contexts;
  end if;

  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if v_chat.occurrence_count <> 4 or v_chat.document_count <> 2 then
    raise exception 'chat after reviving document is %/%', v_chat.occurrence_count, v_chat.document_count;
  end if;
  if jsonb_array_length(v_chat.contexts) <> 2 then
    raise exception 'chat revived contexts are wrong: %', v_chat.contexts;
  end if;

  -- oiseau was not re-added; the revive path must not resurrect it.
  select * into v_oiseau from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'oiseau';
  if v_oiseau.deleted_at is null then
    raise exception 'a lemma absent from the new payload was revived';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Word state changes refresh exactly the affected entry.
-- ---------------------------------------------------------------------------

create temp table before_state as
select
  (select to_jsonb(w) from public.wordbook_entries w
   where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chat') as chat,
  (select to_jsonb(w) from public.wordbook_entries w
   where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chien') as chien,
  (select to_jsonb(w) from public.wordbook_entries w
   where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'lune') as lune;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

update public.word_states
set status = 'unknown',
    is_favorite = false,
    star_angle = 90,
    star_color = '#00ff00',
    seen_count = 9,
    known_presses = 4,
    unsure_presses = 5,
    unknown_presses = 6,
    note = 'second note',
    note_updated_at = now(),
    favorite_updated_at = now(),
    last_seen_at = now()
where user_id = :'user_id'::uuid and language_code = 'fr' and lemma = 'chat';

-- A state for a lemma with no occurrence still is not part of the projection.
insert into public.word_states (user_id, language_code, lemma, status)
values (:'user_id'::uuid, 'fr', 'ours', 'unsure');

reset role;

do $$
declare
  v_before record;
  v_chat public.wordbook_entries%rowtype;
begin
  select * into v_before from before_state;
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';

  if v_chat.status <> 'unknown'
     or v_chat.is_favorite
     or v_chat.star_angle <> 90
     or v_chat.star_color <> '#00ff00'
     or v_chat.seen_count <> 9
     or v_chat.known_presses <> 4
     or v_chat.unsure_presses <> 5
     or v_chat.unknown_presses <> 6
     or v_chat.note <> 'second note'
     or v_chat.note_updated_at is null
     or v_chat.favorite_updated_at is null then
    raise exception 'word state change did not refresh the entry state: %', v_chat;
  end if;
  if v_chat.occurrence_count <> 4 or v_chat.document_count <> 2
     or v_chat.surfaces is distinct from array['chat']
     or jsonb_array_length(v_chat.contexts) <> 2 then
    raise exception 'word state change rewrote occurrence-derived fields: %', v_chat;
  end if;
  if v_chat.server_updated_at <= (v_before.chat->>'server_updated_at')::timestamptz then
    raise exception 'word state change did not advance server_updated_at';
  end if;

  -- The other entries kept every field.
  if (select to_jsonb(w) from public.wordbook_entries w
      where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chien')
     is distinct from v_before.chien then
    raise exception 'a chat state change rewrote the chien entry';
  end if;
  if (select to_jsonb(w) from public.wordbook_entries w
      where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'lune')
     is distinct from v_before.lune then
    raise exception 'a chat state change rewrote the lune entry';
  end if;

  if exists (
    select 1 from public.wordbook_entries
    where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'ours'
  ) then
    raise exception 'a word state without an occurrence leaked into the projection';
  end if;
end $$;

-- Deleting the state rolls the projected state back to the defaults and
-- leaves occurrence-derived fields alone.
create temp table before_state_delete as
select to_jsonb(w) as j from public.wordbook_entries w
where w.user_id = current_setting('test.user_id')::uuid and w.lemma = 'chat';

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
delete from public.word_states
where user_id = :'user_id'::uuid and language_code = 'fr' and lemma = 'chat';
reset role;

do $$
declare
  v_chat public.wordbook_entries%rowtype;
  v_before jsonb;
begin
  select j into v_before from before_state_delete;
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if v_chat.status is not null or v_chat.is_favorite or v_chat.star_angle <> 0
     or v_chat.star_color <> '#eab308' or v_chat.seen_count <> 1
     or v_chat.known_presses <> 0 or v_chat.unsure_presses <> 0 or v_chat.unknown_presses <> 0
     or v_chat.note is not null or v_chat.note_updated_at is not null
     or v_chat.favorite_updated_at is not null then
    raise exception 'state deletion did not reset projected state: %', v_chat;
  end if;
  if v_chat.occurrence_count <> 4 or v_chat.document_count <> 2
     or v_chat.surfaces is distinct from array['chat']
     or jsonb_array_length(v_chat.contexts) <> 2 then
    raise exception 'state deletion rewrote occurrence fields: %', v_chat;
  end if;
  if v_chat.server_updated_at <= (v_before->>'server_updated_at')::timestamptz then
    raise exception 'state deletion did not advance server_updated_at';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Document purge: direct delete (R2 path) and the delete_document RPC.
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

-- d1 has chat/chien; d2 still has chat. Direct delete, as an R2 client does.
delete from public.documents where id = :'d1'::uuid;

-- d4's sole lemma is soft-deleted through the dedicated RPC.
select public.delete_document(:'d4');

reset role;

do $$
declare
  v_chat public.wordbook_entries%rowtype;
  v_chien public.wordbook_entries%rowtype;
  v_soleil public.wordbook_entries%rowtype;
  v_d2 uuid := current_setting('test.d2')::uuid;
begin
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if v_chat.occurrence_count <> 2 or v_chat.document_count <> 1 then
    raise exception 'shared lemma lost the surviving document: %/%',
      v_chat.occurrence_count, v_chat.document_count;
  end if;
  if v_chat.deleted_at is not null then
    raise exception 'shared lemma was soft-deleted while another document still has it';
  end if;
  if v_chat.contexts <> jsonb_build_array(
       jsonb_build_object('documentId', v_d2, 'sentence', 'Un chat noir.')
     ) then
    raise exception 'shared lemma kept the deleted document context: %', v_chat.contexts;
  end if;

  select * into v_chien from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chien';
  if v_chien.deleted_at is null then
    raise exception 'direct delete left a unique lemma live';
  end if;

  select * into v_soleil from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'soleil';
  if v_soleil.deleted_at is null then
    raise exception 'delete_document left a unique lemma live';
  end if;

  if exists (
    select 1 from public.wordbook_refresh_queue
    where user_id = current_setting('test.user_id')::uuid
  ) then
    raise exception 'purge left work in the refresh queue';
  end if;
end $$;

-- The RPC refuses another tenant's document and writes nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
do $$
begin
  begin
    perform public.delete_document(current_setting('test.d_other')::uuid);
    raise exception 'delete_document accepted another tenant''s document';
  exception
    when sqlstate 'P0002' then
      null;
  end;
end $$;
reset role;

do $$
begin
  if not exists (
    select 1 from public.documents where id = current_setting('test.d_other')::uuid
  ) then
    raise exception 'rejected delete_document removed the other tenant''s document';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Two documents share a lemma; both contributions survive an update.
-- ---------------------------------------------------------------------------

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'fifth', 'fr', 'Le chat de plus.')
returning id as d5 \gset
select set_config('test.d5', :'d5', false);

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

select public.replace_word_occurrences(:'d5', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Le chat de plus.","occurrences_count":1}
]'::jsonb);

-- Update the other document. d5's contribution must remain.
select public.replace_word_occurrences(:'d2', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Un chat noir et blanc.","occurrences_count":3}
]'::jsonb);

reset role;

do $$
declare
  v_chat public.wordbook_entries%rowtype;
  v_d2 uuid := current_setting('test.d2')::uuid;
  v_d5 uuid := current_setting('test.d5')::uuid;
begin
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if v_chat.occurrence_count <> 4 or v_chat.document_count <> 2 then
    raise exception 'shared lemma after one document update is %/%',
      v_chat.occurrence_count, v_chat.document_count;
  end if;
  if jsonb_array_length(v_chat.contexts) <> 2
     or not v_chat.contexts @> jsonb_build_array(
          jsonb_build_object('documentId', v_d2, 'sentence', 'Un chat noir et blanc.')
        )
     or not v_chat.contexts @> jsonb_build_array(
          jsonb_build_object('documentId', v_d5, 'sentence', 'Le chat de plus.')
        ) then
    raise exception 'shared lemma contexts are wrong: %', v_chat.contexts;
  end if;
end $$;

-- Updating the other contributor keeps both contributions too.
set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
select public.replace_word_occurrences(:'d5', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Le chat encore.","occurrences_count":5}
]'::jsonb);
reset role;

do $$
declare
  v_chat public.wordbook_entries%rowtype;
begin
  select * into v_chat from public.wordbook_entries
  where user_id = current_setting('test.user_id')::uuid and language_code = 'fr' and lemma = 'chat';
  if v_chat.occurrence_count <> 8 or v_chat.document_count <> 2 then
    raise exception 'shared lemma after the other document update is %/%',
      v_chat.occurrence_count, v_chat.document_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Concurrent shared-lemma updates: no deadlock, deterministic lock order.
--
-- Two sessions replace occurrences in different documents that share the same
-- 30 lemmas, with the lemma order in the two payloads reversed. A test-only
-- trigger records the order in which projection rows are touched. Every
-- transaction must touch the lemmas in ascending (language, lemma) order; that
-- is the property that prevents the two sessions from waiting on each other
-- in opposite directions.
-- ---------------------------------------------------------------------------

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'concurrent a', 'fr', 'Concurrent A.')
returning id as d6 \gset
insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'concurrent b', 'fr', 'Concurrent B.')
returning id as d7 \gset
select set_config('test.d6', :'d6', false);
select set_config('test.d7', :'d7', false);

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

select public.replace_word_occurrences(:'d6', (
  select jsonb_agg(jsonb_build_object(
           'language_code', 'fr',
           'lemma', 'w' || lpad(i::text, 2, '0'),
           'surface', 'w' || lpad(i::text, 2, '0'),
           'char_start', 0,
           'char_end', 2,
           'sentence', 'A phrase ' || i || '.',
           'occurrences_count', 1))
  from generate_series(1, 30) as i
));

select public.replace_word_occurrences(:'d7', (
  select jsonb_agg(jsonb_build_object(
           'language_code', 'fr',
           'lemma', 'w' || lpad(i::text, 2, '0'),
           'surface', 'w' || lpad(i::text, 2, '0'),
           'char_start', 0,
           'char_end', 2,
           'sentence', 'B phrase ' || i || '.',
           'occurrences_count', 1))
  from generate_series(1, 30) as i
));

reset role;

drop trigger if exists _test_log_wordbook_refresh on public.wordbook_entries;
drop function if exists public._test_log_wordbook_refresh();
drop table if exists public._test_wordbook_refresh_log;

create table public._test_wordbook_refresh_log (
  id bigint generated always as identity primary key,
  txid bigint not null default txid_current(),
  lemma text not null
);
alter table public._test_wordbook_refresh_log enable row level security;
revoke all on table public._test_wordbook_refresh_log from public, anon, authenticated;

create or replace function public._test_log_wordbook_refresh()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public._test_wordbook_refresh_log (lemma) values (new.lemma);
  return new;
end;
$$;
revoke all on function public._test_log_wordbook_refresh()
  from public, anon, authenticated;

-- UPDATE only: an ON CONFLICT insert fires BEFORE INSERT triggers even when
-- the insert then loses to an existing row, which would log a lemma twice.
create trigger _test_log_wordbook_refresh
  before update on public.wordbook_entries
  for each row execute function public._test_log_wordbook_refresh();

select case when exists (select 1 from pg_extension where extname = 'dblink') then 1 else 0 end as had_dblink \gset
create extension if not exists dblink with schema extensions;

do $$
declare
  v_user_id uuid := current_setting('test.user_id')::uuid;
  v_d6 uuid := current_setting('test.d6')::uuid;
  v_d7 uuid := current_setting('test.d7')::uuid;
  -- Reversed lemma order on purpose.
  v_payload_a jsonb;
  v_payload_b jsonb;
  v_wait int := 0;
begin
  select jsonb_agg(jsonb_build_object(
           'language_code', 'fr',
           'lemma', 'w' || lpad(i::text, 2, '0'),
           'surface', 'w' || lpad(i::text, 2, '0'),
           'char_start', 0,
           'char_end', 2,
           'sentence', 'A phrase ' || i || '.',
           'occurrences_count', i + 10)
         order by i desc)
  into v_payload_a
  from generate_series(1, 30) as i;

  select jsonb_agg(jsonb_build_object(
           'language_code', 'fr',
           'lemma', 'w' || lpad(i::text, 2, '0'),
           'surface', 'w' || lpad(i::text, 2, '0'),
           'char_start', 0,
           'char_end', 2,
           'sentence', 'B phrase ' || i || '.',
           'occurrences_count', i + 30)
         order by i desc)
  into v_payload_b
  from generate_series(1, 30) as i;

  perform dblink_connect(
    'wq_a',
    'host=supabase_db_translator port=5432 dbname=postgres user=postgres password=postgres application_name=wq_a'
  );
  perform dblink_connect(
    'wq_b',
    'host=supabase_db_translator port=5432 dbname=postgres user=postgres password=postgres application_name=wq_b'
  );
  perform dblink_exec('wq_a', 'set role authenticated');
  perform dblink_exec('wq_b', 'set role authenticated');
  perform * from dblink(
    'wq_a',
    format('select set_config(%L, %L, false)', 'request.jwt.claim.sub', v_user_id::text)
  ) as t(v text);
  perform * from dblink(
    'wq_b',
    format('select set_config(%L, %L, false)', 'request.jwt.claim.sub', v_user_id::text)
  ) as t(v text);

  -- Both RPCs run concurrently over the same 30 projection rows.
  perform dblink_send_query(
    'wq_a',
    format('select public.replace_word_occurrences(%L::uuid, %L::jsonb)', v_d6, v_payload_a)
  );
  perform dblink_send_query(
    'wq_b',
    format('select public.replace_word_occurrences(%L::uuid, %L::jsonb)', v_d7, v_payload_b)
  );

  while dblink_is_busy('wq_a') = 1 or dblink_is_busy('wq_b') = 1 loop
    if v_wait >= 400 then
      raise exception 'concurrent shared-lemma update did not finish within 20s';
    end if;
    perform pg_sleep(0.05);
    v_wait := v_wait + 1;
  end loop;

  -- Raises if either session failed (including a deadlock abort).
  perform * from dblink_get_result('wq_a') as t(v text);
  perform * from dblink_get_result('wq_a') as t(v text);
  perform * from dblink_get_result('wq_b') as t(v text);
  perform * from dblink_get_result('wq_b') as t(v text);

  perform dblink_disconnect('wq_a');
  perform dblink_disconnect('wq_b');

  -- Each transaction touched the 30 rows in ascending lemma order.
  if (select count(distinct txid) from public._test_wordbook_refresh_log) <> 2 then
    raise exception 'expected two concurrent transactions in the refresh log, found %',
      (select count(distinct txid) from public._test_wordbook_refresh_log);
  end if;
  if exists (
    select 1
    from public._test_wordbook_refresh_log
    group by txid
    having count(*) <> 30
  ) then
    raise exception 'a concurrent transaction did not log 30 projection writes';
  end if;

  if exists (
    select 1
    from (
      select txid, array_agg(lemma order by id) as lemmas
      from public._test_wordbook_refresh_log
      group by txid
    ) logged
    where logged.lemmas is distinct from (
      select array_agg(l order by l) from unnest(logged.lemmas) as l
    )
  ) then
    raise exception 'projection rows were not locked in (language, lemma) order';
  end if;

  if (select count(*) from public.wordbook_entries
      where user_id = v_user_id and lemma like 'w%') <> 30 then
    raise exception 'concurrent update lost projection rows';
  end if;
end $$;

do $$
declare
  v_bad text[];
begin
  select array_agg('w' || lpad(i::text, 2, '0')) into v_bad
  from generate_series(1, 30) as i
  where not exists (
    select 1 from public.wordbook_entries w
    where w.user_id = current_setting('test.user_id')::uuid
      and w.language_code = 'fr'
      and w.lemma = 'w' || lpad(i::text, 2, '0')
      and w.occurrence_count = 2 * i + 40
      and w.document_count = 2
      and jsonb_array_length(w.contexts) = 2
      and w.deleted_at is null
  );
  if v_bad is not null then
    raise exception 'concurrent update produced wrong projection rows: %', v_bad;
  end if;
end $$;

drop trigger _test_log_wordbook_refresh on public.wordbook_entries;
drop function public._test_log_wordbook_refresh();
drop table public._test_wordbook_refresh_log;

\if :had_dblink
\else
drop extension if exists dblink;
\endif

-- ---------------------------------------------------------------------------
-- 10. Deleting a user cascades its projection without a refresh race.
-- ---------------------------------------------------------------------------

delete from auth.users where id = :'cascade_user_id'::uuid;
insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (:'cascade_user_id'::uuid, 'authenticated', 'authenticated', 'refresh-cascade@example.test', now(), now(), now());

insert into public.documents (user_id, title, language_code, raw_text)
values (:'cascade_user_id'::uuid, 'cascade', 'fr', 'Le chat dort.')
returning id as c1 \gset

set role authenticated;
select set_config('request.jwt.claim.sub', :'cascade_user_id', false);
select public.replace_word_occurrences(:'c1', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":3,"char_end":7,"sentence":"Le chat dort.","occurrences_count":1}
]'::jsonb);
insert into public.word_states (user_id, language_code, lemma, status)
values (:'cascade_user_id'::uuid, 'fr', 'chat', 'known');
reset role;

do $$
declare
  v_user uuid := current_setting('test.cascade_user_id')::uuid;
begin
  if not exists (
    select 1 from public.wordbook_entries w
    where w.user_id = v_user and w.lemma = 'chat' and w.deleted_at is null
  ) then
    raise exception 'cascade fixture has no live projection entry';
  end if;
end $$;

delete from auth.users where id = :'cascade_user_id'::uuid;

do $$
declare
  v_user uuid := current_setting('test.cascade_user_id')::uuid;
begin
  if exists (select 1 from public.documents where user_id = v_user) then
    raise exception 'user deletion left documents';
  end if;
  if exists (select 1 from public.wordbook_entries where user_id = v_user) then
    raise exception 'user deletion left projection entries';
  end if;
  if exists (select 1 from public.wordbook_refresh_queue where user_id = v_user) then
    raise exception 'user deletion left purge work';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------

delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid, :'cascade_user_id'::uuid);
do $$
begin
  if to_regclass('public.wordbook_refresh_queue') is not null then
    delete from public.wordbook_refresh_queue
    where user_id in (
      current_setting('test.user_id')::uuid,
      current_setting('test.other_user_id')::uuid,
      current_setting('test.cascade_user_id')::uuid
    );
  end if;
end $$;
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid, :'cascade_user_id'::uuid);

\echo 'wordbook_refresh: PASS'
