-- Server-side no-op/diff proof for replace_word_occurrences.
--
-- Run after `npx supabase db reset`:
--   docker exec -i supabase_db_translator psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/occurrence_noop_diff.sql
--
-- The whole file is one psql session. Setup runs as the database owner; the
-- RPC calls run as `authenticated` with request.jwt.claim.sub set, so the RLS
-- and ownership checks are exercised exactly as a client would hit them.

\set user_id '00000000-0000-4000-8000-00000000a001'
\set other_user_id '00000000-0000-4000-8000-00000000a002'

-- Clean any leftover run (cascades remove documents and occurrences).
delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid);
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  (:'user_id'::uuid, 'authenticated', 'authenticated', 'noop-diff-a@example.test', now(), now(), now()),
  (:'other_user_id'::uuid, 'authenticated', 'authenticated', 'noop-diff-b@example.test', now(), now(), now());

insert into public.documents (user_id, title, language_code, raw_text)
values (:'user_id'::uuid, 'no-op test', 'fr', 'Le chat dort.')
returning id as document_id \gset

insert into public.documents (user_id, title, language_code, raw_text)
values (:'other_user_id'::uuid, 'other tenant', 'fr', 'Le chien dort.')
returning id as other_document_id \gset

select set_config('test.document_id', :'document_id', false);
select set_config('test.other_document_id', :'other_document_id', false);
select set_config('test.user_id', :'user_id', false);

-- Act as the document owner from here on.
set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

-- ---------------------------------------------------------------------------
-- First write: two rows in a fixed order.
-- ---------------------------------------------------------------------------

select replace_word_occurrences(:'document_id', '[
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat dort.","occurrences_count":1},
  {"language_code":"fr","lemma":"dort","surface":"dort","char_start":7,"char_end":11,"sentence":"Le chat dort.","occurrences_count":1}
]'::jsonb);

do $$
declare
  v_hash text;
begin
  select occurrences_hash into v_hash
  from public.documents where id = current_setting('test.document_id')::uuid;
  if v_hash is null then
    raise exception 'first write did not set occurrences_hash';
  end if;
  if (select count(*) from public.word_occurrences
      where document_id = current_setting('test.document_id')::uuid) <> 2 then
    raise exception 'first write did not store two rows';
  end if;
end $$;

create temp table before_noop as
select occurrences_hash, server_updated_at
from public.documents where id = :'document_id';

create temp table before_rows as
select
  xmin::text as row_version,
  id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count
from public.word_occurrences where document_id = :'document_id';

-- ---------------------------------------------------------------------------
-- Reordered identical rows: no row write, same hash, same server_updated_at.
-- `occurrences_count` as a string proves canonical typing, not JSON typing.
-- ---------------------------------------------------------------------------

select replace_word_occurrences(:'document_id', '[
  {"language_code":"fr","lemma":"dort","surface":"dort","char_start":7,"char_end":11,"sentence":"Le chat dort.","occurrences_count":"1"},
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat dort.","occurrences_count":1}
]'::jsonb);

do $$
declare
  before_row record;
  v_hash text;
  v_server timestamptz;
  v_rows int;
begin
  select * into before_row from before_noop;
  select occurrences_hash, server_updated_at into v_hash, v_server
  from public.documents where id = current_setting('test.document_id')::uuid;

  if v_hash is distinct from before_row.occurrences_hash then
    raise exception 'no-op changed occurrences_hash';
  end if;
  if v_server is distinct from before_row.server_updated_at then
    raise exception 'no-op changed server_updated_at';
  end if;

  -- Same row identities, values, and row versions: a delete+insert changes
  -- the ids, and even an upsert without a difference check changes xmin.
  select count(*) into v_rows
  from (
    (select row_version, id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count
     from before_rows
     except
     select xmin::text, id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count
     from public.word_occurrences
     where document_id = current_setting('test.document_id')::uuid)
    union all
    (select xmin::text, id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count
     from public.word_occurrences
     where document_id = current_setting('test.document_id')::uuid
     except
     select row_version, id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count
     from before_rows)
  ) diff;
  if v_rows <> 0 then
    raise exception 'no-op changed word_occurrences rows';
  end if;
  if (select count(*) from public.word_occurrences
      where document_id = current_setting('test.document_id')::uuid) <> 2 then
    raise exception 'no-op duplicated word_occurrences rows';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- One-character real change: writes, changes hash, updates one row, no dupes.
-- ---------------------------------------------------------------------------

select replace_word_occurrences(:'document_id', '[
  {"language_code":"fr","lemma":"dort","surface":"dort","char_start":7,"char_end":11,"sentence":"Le chat dort.","occurrences_count":1},
  {"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat mange.","occurrences_count":1}
]'::jsonb);

do $$
declare
  before_row record;
  v_hash text;
  v_server timestamptz;
begin
  select * into before_row from before_noop;
  select occurrences_hash, server_updated_at into v_hash, v_server
  from public.documents where id = current_setting('test.document_id')::uuid;

  if v_hash is not distinct from before_row.occurrences_hash then
    raise exception 'real change did not update occurrences_hash';
  end if;
  if v_server <= before_row.server_updated_at then
    raise exception 'real change did not advance server_updated_at';
  end if;
  if (select count(*) from public.word_occurrences
      where document_id = current_setting('test.document_id')::uuid) <> 2 then
    raise exception 'real change duplicated word_occurrences rows';
  end if;
  if (select count(*) from public.word_occurrences
      where document_id = current_setting('test.document_id')::uuid
        and lemma = 'chat' and sentence = 'Le chat mange.') <> 1 then
    raise exception 'real change did not update the changed row';
  end if;

  -- Only the changed row was written; the untouched row kept its row version.
  if (select xmin::text from public.word_occurrences
      where document_id = current_setting('test.document_id')::uuid
        and lemma = 'dort')
     is distinct from
     (select row_version from before_rows where lemma = 'dort') then
    raise exception 'real change rewrote an unchanged row';
  end if;
  if (select xmin::text from public.word_occurrences
      where document_id = current_setting('test.document_id')::uuid
        and lemma = 'chat')
     is not distinct from
     (select row_version from before_rows where lemma = 'chat') then
    raise exception 'real change did not write the changed row';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Empty replacement: clears rows, and a second empty call is a no-op.
-- ---------------------------------------------------------------------------

select replace_word_occurrences(:'document_id', '[]'::jsonb);

do $$
begin
  if exists (
    select 1 from public.word_occurrences
    where document_id = current_setting('test.document_id')::uuid
  ) then
    raise exception 'empty replacement left word_occurrences rows';
  end if;
  if (select occurrences_hash from public.documents
      where id = current_setting('test.document_id')::uuid) is null then
    raise exception 'empty replacement did not set occurrences_hash';
  end if;
end $$;

create temp table before_empty_noop as
select occurrences_hash, server_updated_at
from public.documents where id = :'document_id';

select replace_word_occurrences(:'document_id', '[]'::jsonb);

do $$
declare
  before_row record;
  v_hash text;
  v_server timestamptz;
begin
  select * into before_row from before_empty_noop;
  select occurrences_hash, server_updated_at into v_hash, v_server
  from public.documents where id = current_setting('test.document_id')::uuid;
  if v_hash is distinct from before_row.occurrences_hash then
    raise exception 'second empty call changed occurrences_hash';
  end if;
  if v_server is distinct from before_row.server_updated_at then
    raise exception 'second empty call changed server_updated_at';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Hash canonicalization: order and optional count are not significant.
-- ---------------------------------------------------------------------------

do $$
declare
  v_forward text;
  v_reverse text;
begin
  v_forward := public.word_occurrence_hash('[
    {"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat dort.","occurrences_count":1},
    {"language_code":"fr","lemma":"dort","surface":"dort","char_start":7,"char_end":11,"sentence":"Le chat dort.","occurrences_count":2}
  ]'::jsonb);
  v_reverse := public.word_occurrence_hash('[
    {"language_code":"fr","lemma":"dort","surface":"dort","char_start":7,"char_end":11,"sentence":"Le chat dort.","occurrences_count":2},
    {"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat dort.","occurrences_count":1}
  ]'::jsonb);
  if v_forward is distinct from v_reverse then
    raise exception 'word_occurrence_hash depends on row order';
  end if;
  if public.word_occurrence_hash('[{"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat dort."}]'::jsonb)
     is distinct from public.word_occurrence_hash('[{"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat dort.","occurrences_count":1}]'::jsonb) then
    raise exception 'word_occurrence_hash treats default count as a change';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Ownership: the caller's document is accepted; another tenant's is rejected.
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    perform public.replace_word_occurrences(
      current_setting('test.other_document_id')::uuid,
      '[{"language_code":"fr","lemma":"chien","surface":"chien","char_start":0,"char_end":5,"sentence":"Le chien dort.","occurrences_count":1}]'::jsonb
    );
    raise exception 'cross-tenant replace_word_occurrences was accepted';
  exception
    when sqlstate 'P0002' then
      null;
  end;
end $$;

-- The caller cannot even see another tenant's document through RLS.
do $$
begin
  if exists (
    select 1 from public.documents
    where id = current_setting('test.other_document_id')::uuid
  ) then
    raise exception 'another tenant''s document is visible to the caller';
  end if;
end $$;

reset role;

-- Read as the database owner: the rejected call wrote nothing, anywhere.
do $$
begin
  if exists (
    select 1 from public.word_occurrences
    where document_id = current_setting('test.other_document_id')::uuid
  ) then
    raise exception 'cross-tenant call wrote word_occurrences rows';
  end if;
  if (select occurrences_hash from public.documents
      where id = current_setting('test.other_document_id')::uuid) is not null then
    raise exception 'cross-tenant call wrote occurrences_hash';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Same-document pushes are serialized
--
-- Two independent psql sessions (dblink) push different payloads for the same
-- document. Session A holds an open transaction after its RPC, so session B must
-- block on the document row lock before it reads the hash or writes any
-- occurrence row. A commits; B then re-reads the committed hash and replaces the
-- row set instead of leaving A's rows behind. Without the lock B would write
-- first and only block on the final documents update, leaving a superset of
-- rows whose hash matches B alone.
--
-- The poll is synchronization, not a sleep-based proof: the test asserts B is
-- in a lock wait while A is uncommitted, then asserts the exact final row set.
-- ---------------------------------------------------------------------------

select case when exists (select 1 from pg_extension where extname = 'dblink') then 1 else 0 end as had_dblink \gset
create extension if not exists dblink with schema extensions;

do $$
declare
  v_document_id uuid := current_setting('test.document_id')::uuid;
  v_user_id uuid := current_setting('test.user_id')::uuid;
  v_payload_a jsonb := '[
    {"language_code":"fr","lemma":"chat","surface":"chat","char_start":0,"char_end":4,"sentence":"Le chat dort.","occurrences_count":1}
  ]'::jsonb;
  v_payload_b jsonb := '[
    {"language_code":"fr","lemma":"chien","surface":"chien","char_start":0,"char_end":5,"sentence":"Le chien dort.","occurrences_count":1}
  ]'::jsonb;
  v_wait int := 0;
begin
  perform dblink_connect(
    'task1_a',
    'host=supabase_db_translator port=5432 dbname=postgres user=postgres password=postgres application_name=task1_a'
  );
  perform dblink_connect(
    'task1_b',
    'host=supabase_db_translator port=5432 dbname=postgres user=postgres password=postgres application_name=task1_b'
  );

  perform dblink_exec('task1_a', 'set role authenticated');
  perform dblink_exec('task1_b', 'set role authenticated');
  perform * from dblink(
    'task1_a',
    format('select set_config(%L, %L, false)', 'request.jwt.claim.sub', v_user_id::text)
  ) as t(v text);
  perform * from dblink(
    'task1_b',
    format('select set_config(%L, %L, false)', 'request.jwt.claim.sub', v_user_id::text)
  ) as t(v text);

  -- A's transaction stays open, holding the document row lock.
  perform dblink_exec('task1_a', 'begin');
  perform * from dblink(
    'task1_a',
    format('select public.replace_word_occurrences(%L::uuid, %L::jsonb)', v_document_id, v_payload_a)
  ) as t(v text);

  perform dblink_send_query(
    'task1_b',
    format('select public.replace_word_occurrences(%L::uuid, %L::jsonb)', v_document_id, v_payload_b)
  );

  while v_wait < 200 loop
    if exists (
      select 1
      from pg_stat_activity
      where application_name = 'task1_b'
        and state = 'active'
        and wait_event_type = 'Lock'
    ) then
      exit;
    end if;
    perform pg_sleep(0.05);
    v_wait := v_wait + 1;
  end loop;

  if v_wait >= 200 then
    raise exception 'second session did not block on the locked document';
  end if;

  perform dblink_exec('task1_a', 'commit');

  v_wait := 0;
  while dblink_is_busy('task1_b') = 1 loop
    if v_wait >= 200 then
      raise exception 'second session did not finish after the lock was released';
    end if;
    perform pg_sleep(0.05);
    v_wait := v_wait + 1;
  end loop;

  -- Raises if the remote RPC failed.
  perform * from dblink_get_result('task1_b') as t(v text);
  perform * from dblink_get_result('task1_b') as t(v text);

  perform dblink_disconnect('task1_a');
  perform dblink_disconnect('task1_b');

  if (select array_agg(lemma order by lemma) from public.word_occurrences
      where document_id = v_document_id)
     is distinct from array['chien'] then
    raise exception 'serialized replacement left a mixed row set: %',
      (select array_agg(lemma order by lemma) from public.word_occurrences
       where document_id = v_document_id);
  end if;
  if (select occurrences_hash from public.documents where id = v_document_id)
     is distinct from public.word_occurrence_hash(v_payload_b) then
    raise exception 'serialized replacement stored the wrong hash';
  end if;
end $$;

\if :had_dblink
\else
drop extension if exists dblink;
\endif

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------

delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid);
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid);

\echo 'occurrence_noop_diff: PASS'
