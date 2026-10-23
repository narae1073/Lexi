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
-- Cleanup
-- ---------------------------------------------------------------------------

delete from public.documents where user_id in (:'user_id'::uuid, :'other_user_id'::uuid);
delete from auth.users where id in (:'user_id'::uuid, :'other_user_id'::uuid);

\echo 'occurrence_noop_diff: PASS'
