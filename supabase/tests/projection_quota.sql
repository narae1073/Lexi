-- Projection quotas and the server-side pass state machine (R3, task 13
-- review).
--
-- Run after `npx supabase db reset` (or after applying all migrations):
--   docker exec -i supabase_db_translator psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/projection_quota.sql
--
-- The page RPC uses the production defaults: 60 pages per user per minute,
-- 5 complete syncs per user per UTC day, and a server cursor per
-- (user, snapshot, language). The fixture pre-seeds window counters / pass
-- rows as the database owner, then exercises the real functions as
-- `authenticated` with request.jwt.claim.sub set.
--
-- A separate integration test, `supabase/tests/projection_quota_concurrency.mjs`,
-- fires two real PostgREST first-page requests at once to prove the per-user
-- advisory lock lets exactly one take the last daily unit.

\set user_id '00000000-0000-4000-8000-00000000f001'
\set other_user_id '00000000-0000-4000-8000-00000000f002'
\set third_user_id '00000000-0000-4000-8000-00000000f003'
\set fourth_user_id '00000000-0000-4000-8000-00000000f004'
\set snapshot '2026-10-28 12:00:00+00'

select set_config('test.user_id', :'user_id', false);
select set_config('test.other_user_id', :'other_user_id', false);
select set_config('test.third_user_id', :'third_user_id', false);
select set_config('test.fourth_user_id', :'fourth_user_id', false);
select set_config('test.snapshot', :'snapshot', false);

-- Fail with a readable message while the migration is still missing.
do $$
begin
  if to_regprocedure('public.consume_projection_quota(text, int, int)') is null then
    raise exception 'consume_projection_quota(text, int, int) is missing';
  end if;
  if to_regprocedure('public.consume_projection_sync(timestamp with time zone, text)') is null then
    raise exception 'consume_projection_sync(timestamptz, text) is missing';
  end if;
  if to_regclass('public.projection_sync_passes') is null then
    raise exception 'public.projection_sync_passes is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projection_sync_passes'
      and column_name = 'last_cursor'
  ) then
    raise exception 'projection_sync_passes has no cursor state';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Shape and grants
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
      'get_wordbook_projection_page_bounded',
      'consume_projection_quota',
      'consume_projection_snapshot',
      'consume_projection_sync',
      'begin_projection_read',
      'record_projection_usage',
      'prune_projection_usage'
    )
    and (
      -- The page RPCs are the only read paths now, so they must be definer-owned
      -- with a pinned search_path. Every internal helper is definer-owned too.
      not p.prosecdef
      or not (p.proconfig @> array['search_path=public, pg_temp'])
      or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and p.proname in ('get_wordbook_projection_page', 'get_wordbook_projection_page_bounded')
      or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and p.proname in ('consume_projection_quota', 'begin_projection_read')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and p.proname in ('consume_projection_sync', 'consume_projection_snapshot',
          'record_projection_usage', 'prune_projection_usage')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
    );
  if v_bad is not null then
    raise exception 'projection quota functions are missing, invoker-based, or wrongly granted: %',
      v_bad;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.projection_usage'::regclass) then
    raise exception 'projection_usage does not have RLS enabled';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.projection_sync_passes'::regclass) then
    raise exception 'projection_sync_passes does not have RLS enabled';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.projection_read_sessions'::regclass) then
    raise exception 'projection_read_sessions does not have RLS enabled';
  end if;

  -- The page RPC is the only way a client reads wordbook rows. A direct
  -- PostgREST range request must fail before RLS is even considered.
  if has_table_privilege('authenticated', 'public.wordbook_entries', 'SELECT') then
    raise exception 'authenticated still has direct SELECT on wordbook_entries';
  end if;

  if has_table_privilege('authenticated', 'public.projection_usage', 'SELECT')
     or has_table_privilege('authenticated', 'public.projection_usage', 'INSERT')
     or has_table_privilege('authenticated', 'public.projection_usage', 'UPDATE')
     or has_table_privilege('authenticated', 'public.projection_usage', 'DELETE')
     or has_table_privilege('anon', 'public.projection_usage', 'SELECT')
     or has_table_privilege('authenticated', 'public.projection_sync_passes', 'SELECT')
     or has_table_privilege('authenticated', 'public.projection_sync_passes', 'INSERT')
     or has_table_privilege('anon', 'public.projection_sync_passes', 'SELECT')
     or has_table_privilege('authenticated', 'public.projection_read_sessions', 'SELECT')
     or has_table_privilege('anon', 'public.projection_read_sessions', 'SELECT') then
    raise exception 'projection quota tables are directly readable or writable by a client role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

delete from public.projection_usage
where user_id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);
delete from public.projection_sync_passes
where user_id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);
delete from public.projection_read_sessions
where user_id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);
delete from auth.users
where id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  (:'user_id'::uuid, 'authenticated', 'authenticated', 'quota-a@example.test', now(), now(), now()),
  (:'other_user_id'::uuid, 'authenticated', 'authenticated', 'quota-b@example.test', now(), now(), now()),
  (:'third_user_id'::uuid, 'authenticated', 'authenticated', 'quota-c@example.test', now(), now(), now()),
  (:'fourth_user_id'::uuid, 'authenticated', 'authenticated', 'quota-d@example.test', now(), now(), now());

alter table public.wordbook_entries disable trigger wordbook_entries_server_updated_at;

insert into public.wordbook_entries (user_id, language_code, lemma, server_updated_at)
values
  (:'user_id'::uuid, 'fr', 'alpha', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'user_id'::uuid, 'fr', 'beta', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'user_id'::uuid, 'fr', 'gamma', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'user_id'::uuid, 'fr', 'delta', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'other_user_id'::uuid, 'fr', 'alpha', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'other_user_id'::uuid, 'fr', 'beta', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'third_user_id'::uuid, 'fr', 'alpha', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'fourth_user_id'::uuid, 'fr', 'alpha', current_setting('test.snapshot')::timestamptz - interval '1 minute');

alter table public.wordbook_entries enable trigger wordbook_entries_server_updated_at;

-- Fixed windows, computed exactly as the function does.
create or replace function pg_temp.window_start(p_seconds int)
returns timestamptz
language sql
stable
as $$
  select to_timestamp(floor(extract(epoch from clock_timestamp()) / p_seconds) * p_seconds);
$$;

-- Test-only reset. Only reachable as the database owner (the test calls it
-- after `reset role`); it is not granted to any client role.
create or replace function pg_temp.reset_projection(p_user_id uuid)
returns void
language sql
as $$
  delete from public.projection_sync_passes where user_id = p_user_id;
  delete from public.projection_read_sessions where user_id = p_user_id;
  delete from public.projection_usage where user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- 1. RLS: direct table access is gone; the RPC still works
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
begin
  begin
    perform 1 from public.wordbook_entries limit 1;
    raise exception 'authenticated read wordbook_entries directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.projection_usage limit 1;
    raise exception 'authenticated read projection_usage directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.projection_sync_passes limit 1;
    raise exception 'authenticated read projection_sync_passes directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.record_projection_usage('projection_rows', 1, 86400);
    raise exception 'authenticated executed record_projection_usage';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.prune_projection_usage(14);
    raise exception 'authenticated executed prune_projection_usage';
  exception
    when insufficient_privilege then null;
  end;

  -- The page RPC is the permitted read path and returns only this account.
  if exists (
    select 1 from public.get_wordbook_projection_page(
      'fr', null, current_setting('test.snapshot')::timestamptz, null, 100
    )
    where user_id <> current_setting('test.user_id')::uuid
  ) then
    raise exception 'the page RPC returned another account row';
  end if;

  if not public.consume_projection_quota('projection_page', 60, 60) then
    raise exception 'the caller''s own quota could not be consumed';
  end if;
end $$;

reset role;

set role anon;
do $$
begin
  begin
    perform public.consume_projection_quota('projection_page', 60, 60);
    raise exception 'anon executed consume_projection_quota';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.projection_usage limit 1;
    raise exception 'anon read projection_usage';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

select pg_temp.reset_projection(:'user_id'::uuid);

-- ---------------------------------------------------------------------------
-- 2. Page budget: under the limit passes, the next request is a typed 429
-- ---------------------------------------------------------------------------

insert into public.projection_usage (user_id, bucket, window_start, count)
values (:'user_id'::uuid, 'projection_page', pg_temp.window_start(60), 59);

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_count int;
  v_detail text;
  v_hint text;
begin
  -- The 60th page of this window is allowed (this also starts the pass).
  select count(*) into v_count
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 2);
  if v_count <> 2 then
    raise exception 'allowed page returned % rows, expected 2', v_count;
  end if;

  -- The 61st is denied before any row is returned.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', 'beta', v_snapshot, null, 2);
    raise exception 'page 61 of the minute was allowed';
  exception
    when sqlstate 'PT429' then
      get stacked diagnostics v_detail = pg_exception_detail,
                              v_hint = pg_exception_hint;
  end;

  if v_detail is null or v_detail not like 'bucket=page;retry_after_seconds=%' then
    raise exception 'page quota denial detail is %', v_detail;
  end if;
  if split_part(v_detail, 'retry_after_seconds=', 2)::int <= 0 then
    raise exception 'page quota denial has no positive retry window: %', v_detail;
  end if;
  if v_hint is null or v_hint = '' then
    raise exception 'page quota denial has no hint';
  end if;
end $$;

-- Another user is untouched by the first user's exhaustion.
select set_config('request.jwt.claim.sub', :'other_user_id', false);
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.get_wordbook_projection_page(
    'fr', null, current_setting('test.snapshot')::timestamptz, null, 100
  );
  if v_count <> 2 then
    raise exception 'a second user was denied by the first user''s page quota: % rows', v_count;
  end if;
end $$;

reset role;
select pg_temp.reset_projection(:'user_id'::uuid);

-- ---------------------------------------------------------------------------
-- 3. Server cursor state: start, resume, replay, arbitrary cursor
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_lemmas text[];
begin
  -- Page 1: alpha, beta. The pass stores beta and no previous cursor yet.
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 2);
  if v_lemmas is distinct from array['alpha', 'beta'] then
    raise exception 'first page is %, expected {alpha,beta}', v_lemmas;
  end if;

  -- Page 2 matches the stored cursor and returns the last two rows. The
  -- server knows no row follows gamma, so `hasMore` is false and the pass
  -- completes on this page; a client never requests an empty page.
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', 'beta', v_snapshot, null, 2);
  if v_lemmas is distinct from array['delta', 'gamma'] then
    raise exception 'second page is %, expected {delta,gamma}', v_lemmas;
  end if;

  -- Replaying the final page is idempotent: a crash after the server stored
  -- completion but before the client stored the rows must still get them.
  -- The replay anchor is the input cursor of the page that completed (beta).
  perform 1
  from public.get_wordbook_projection_page('fr', 'beta', v_snapshot, null, 2);

  -- Any other cursor is rejected: it could skip rows.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', 'gamma', v_snapshot, null, 2);
    raise exception 'a completed pass accepted another cursor';
  exception
    when sqlstate 'PT409' then null;
  end;
end $$;

reset role;
select pg_temp.reset_projection(:'user_id'::uuid);
set role authenticated;

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_lemmas text[];
begin
  perform 1
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 2);

  -- The empty cursor used to be accepted as a "resume" and bypassed the daily
  -- charge. It is now a typed client error.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', '', v_snapshot, null, 2);
    raise exception 'an empty cursor was accepted';
  exception
    when sqlstate 'PT400' then null;
  end;

  -- An arbitrary cursor on an incomplete pass is rejected.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', 'zzz', v_snapshot, null, 2);
    raise exception 'an arbitrary cursor was accepted';
  exception
    when sqlstate 'PT409' then null;
  end;

  -- A retry of page 1 (null cursor with previous_cursor still null) is
  -- accepted. It re-reads the same rows and cannot skip anything.
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 2);
  if v_lemmas is distinct from array['alpha', 'beta'] then
    raise exception 'page 1 retry is %, expected {alpha,beta}', v_lemmas;
  end if;

  -- The normal next cursor still works after the retry.
  select array_agg(lemma order by lemma) into v_lemmas
  from public.get_wordbook_projection_page('fr', 'beta', v_snapshot, null, 2);
  if v_lemmas is distinct from array['delta', 'gamma'] then
    raise exception 'next page after retry is %, expected {delta,gamma}', v_lemmas;
  end if;
end $$;

reset role;
select pg_temp.reset_projection(:'user_id'::uuid);
set role authenticated;

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
begin
  -- A brand-new pass cannot start in the middle of a language.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', 'alpha', v_snapshot, null, 2);
    raise exception 'a new pass started with a non-null cursor';
  exception
    when sqlstate 'PT409' then null;
  end;

  -- Unbounded enumeration is no longer a client mode.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', null, null, null, 2);
    raise exception 'the unbounded mode was accepted';
  exception
    when sqlstate 'PT400' then null;
  end;

  -- Incremental pages remain allowed and do not need pass state.
  if not exists (
    select 1 from public.get_wordbook_projection_page(
      'fr', null, null, current_setting('test.snapshot')::timestamptz - interval '1 day', 2
    )
  ) then
    raise exception 'an incremental page returned no rows';
  end if;
end $$;

reset role;
select pg_temp.reset_projection(:'user_id'::uuid);

do $$
begin
  if exists (
    select 1 from public.projection_sync_passes
    where user_id = current_setting('test.user_id')::uuid
  ) then
    raise exception 'a rejected first page still created pass state';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3b. Language validation: strict shape plus a per-snapshot cap
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz + interval '7 hours';
  v_ok_snapshot timestamptz := current_setting('test.snapshot')::timestamptz + interval '8 hours';
begin
  -- A malformed language cannot create pass state or consume a daily unit.
  begin
    perform 1
    from public.get_wordbook_projection_page('not_a_language', null, v_snapshot, null, 2);
    raise exception 'a malformed language was accepted';
  exception
    when sqlstate 'PT400' then null;
  end;

  -- A valid but unenrolled language is allowed for onboarding (the server has
  -- no user_languages row yet); the cap, not enrollment, bounds the namespace.
  perform 1
  from public.get_wordbook_projection_page('zz', null, v_ok_snapshot, null, 2);
end $$;

reset role;
select pg_temp.reset_projection(:'user_id'::uuid);

-- Seed exactly the per-snapshot cap (50) of valid language rows for one
-- charged snapshot.
insert into public.projection_sync_passes (user_id, snapshot, language_code, started_at)
select
  :'user_id'::uuid,
  current_setting('test.snapshot')::timestamptz + interval '9 hours',
  chr(97 + (g % 26)) || chr(97 + ((g / 26) % 26)),
  clock_timestamp()
from generate_series(0, 49) as g;

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz + interval '9 hours';
begin
  begin
    perform 1
    from public.get_wordbook_projection_page('zz', null, v_snapshot, null, 2);
    raise exception 'a 51st language under one snapshot was accepted';
  exception
    when sqlstate 'PT400' then null;
  end;
end $$;

reset role;

do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.projection_sync_passes
  where user_id = current_setting('test.user_id')::uuid
    and snapshot = current_setting('test.snapshot')::timestamptz + interval '9 hours';
  if v_count <> 50 then
    raise exception 'the language cap left % pass rows, expected 50', v_count;
  end if;

  if exists (
    select 1 from public.projection_sync_passes
    where user_id = current_setting('test.user_id')::uuid
      and language_code = 'zz'
      and snapshot = current_setting('test.snapshot')::timestamptz + interval '9 hours'
  ) then
    raise exception 'the rejected 51st language still created pass state';
  end if;
end $$;

select pg_temp.reset_projection(:'user_id'::uuid);

-- ---------------------------------------------------------------------------
-- 4. Daily budget: five snapshots, resumes/languages are free, a sixth is 429
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_s4 timestamptz := current_setting('test.snapshot')::timestamptz + interval '1 hour';
  v_s5 timestamptz := current_setting('test.snapshot')::timestamptz + interval '2 hours';
  v_s6 timestamptz := current_setting('test.snapshot')::timestamptz + interval '3 hours';
  v_s7 timestamptz := current_setting('test.snapshot')::timestamptz + interval '4 hours';
  v_s8 timestamptz := current_setting('test.snapshot')::timestamptz + interval '5 hours';
  v_detail text;
begin
  perform 1 from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 2);
  perform 1 from public.get_wordbook_projection_page('fr', 'beta', v_snapshot, null, 2); -- resume
  perform 1 from public.get_wordbook_projection_page('fr', null, v_s4, null, 2);        -- pass 2
  perform 1 from public.get_wordbook_projection_page('fr', null, v_s5, null, 2);        -- pass 3
  perform 1 from public.get_wordbook_projection_page('fr', null, v_s6, null, 2);        -- pass 4
  perform 1 from public.get_wordbook_projection_page('fr', null, v_s7, null, 2);        -- pass 5
  perform 1 from public.get_wordbook_projection_page('de', null, v_snapshot, null, 2);   -- another language, pass 1

  begin
    perform 1 from public.get_wordbook_projection_page('fr', null, v_s8, null, 2);
    raise exception 'a sixth complete sync in one day was allowed';
  exception
    when sqlstate 'PT429' then
      get stacked diagnostics v_detail = pg_exception_detail;
  end;
  if v_detail is null or v_detail not like 'bucket=sync;retry_after_seconds=%' then
    raise exception 'daily sync denial detail is %', v_detail;
  end if;
  if split_part(v_detail, 'retry_after_seconds=', 2)::int <= 0 then
    raise exception 'daily sync denial has no positive retry window: %', v_detail;
  end if;

  -- The already-charged pass resumes even though the daily bucket is full.
  perform 1 from public.get_wordbook_projection_page('fr', 'beta', v_snapshot, null, 2);

  -- A second language under the same snapshot is the same charge.
  perform 1 from public.get_wordbook_projection_page('es', null, v_snapshot, null, 2);
end $$;

reset role;

do $$
declare
  v_snapshots int;
  v_languages int;
begin
  select count(distinct snapshot) into v_snapshots
  from public.projection_sync_passes
  where user_id = current_setting('test.user_id')::uuid
    and started_at >= (
      date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'
    );
  if v_snapshots <> 5 then
    raise exception 'daily pass count is %, expected 5 after one denial', v_snapshots;
  end if;

  select count(*) into v_languages
  from public.projection_sync_passes
  where user_id = current_setting('test.user_id')::uuid
    and language_code in ('fr', 'de', 'es');
  if v_languages < 4 then
    raise exception 'expected the charged pass to carry multiple language rows, got %', v_languages;
  end if;

  if not exists (
    select 1 from public.projection_usage
    where user_id = current_setting('test.user_id')::uuid
      and bucket = 'projection_sync_complete'
  ) then
    raise exception 'completed full passes were not recorded for first-sync metrics';
  end if;
end $$;

select pg_temp.reset_projection(:'user_id'::uuid);

-- ---------------------------------------------------------------------------
-- 5. Cross-day behavior: a previous-day pass is charged once for today
-- ---------------------------------------------------------------------------

insert into public.projection_sync_passes
  (user_id, snapshot, language_code, started_at, last_cursor, previous_cursor, complete)
values (
  :'user_id'::uuid,
  current_setting('test.snapshot')::timestamptz,
  'fr',
  clock_timestamp() - interval '1 day',
  null,
  null,
  false
);

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_yesterday timestamptz := current_setting('test.snapshot')::timestamptz;
  v_today2 timestamptz := current_setting('test.snapshot')::timestamptz + interval '4 hours';
  v_today3 timestamptz := current_setting('test.snapshot')::timestamptz + interval '5 hours';
  v_today4 timestamptz := current_setting('test.snapshot')::timestamptz + interval '6 hours';
  v_today5 timestamptz := current_setting('test.snapshot')::timestamptz + interval '7 hours';
  v_today6 timestamptz := current_setting('test.snapshot')::timestamptz + interval '8 hours';
  v_detail text;
begin
  -- Resuming yesterday's snapshot is today's first complete sync.
  perform 1 from public.get_wordbook_projection_page('fr', null, v_yesterday, null, 2);
  -- New snapshots fill the remaining four daily units.
  perform 1 from public.get_wordbook_projection_page('fr', null, v_today2, null, 2);
  perform 1 from public.get_wordbook_projection_page('fr', null, v_today3, null, 2);
  perform 1 from public.get_wordbook_projection_page('fr', null, v_today4, null, 2);
  perform 1 from public.get_wordbook_projection_page('fr', null, v_today5, null, 2);
  -- A sixth distinct snapshot is denied.
  begin
    perform 1 from public.get_wordbook_projection_page('fr', null, v_today6, null, 2);
    raise exception 'a sixth cross-day snapshot was allowed';
  exception
    when sqlstate 'PT429' then
      get stacked diagnostics v_detail = pg_exception_detail;
  end;
  if v_detail is null or v_detail not like 'bucket=sync;retry_after_seconds=%' then
    raise exception 'cross-day denial detail is %', v_detail;
  end if;
end $$;

reset role;

do $$
declare
  v_snapshots int;
begin
  select count(distinct snapshot) into v_snapshots
  from public.projection_sync_passes
  where user_id = current_setting('test.user_id')::uuid
    and started_at >= (
      date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'
    );
  if v_snapshots <> 5 then
    raise exception 'cross-day daily count is %, expected 5', v_snapshots;
  end if;
end $$;

select pg_temp.reset_projection(:'user_id'::uuid);

-- A completed pass from a previous day can replay its final page without a
-- new daily charge (it is not a new complete download).
insert into public.projection_sync_passes
  (user_id, snapshot, language_code, started_at, last_cursor, previous_cursor, final_cursor, complete)
values (
  :'user_id'::uuid,
  current_setting('test.snapshot')::timestamptz + interval '6 hours',
  'fr',
  clock_timestamp() - interval '1 day',
  null,
  null,
  null,
  true
);

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz + interval '6 hours';
  v_count int;
begin
  select count(*) into v_count
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 2);
  if v_count <> 2 then
    raise exception 'completed-pass replay returned % rows, expected 2', v_count;
  end if;
end $$;

reset role;

do $$
begin
  if exists (
    select 1 from public.projection_sync_passes
    where user_id = current_setting('test.user_id')::uuid
      and started_at >= (
        date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'
      )
  ) then
    raise exception 'a completed-pass replay was charged as a new daily sync';
  end if;
end $$;

select pg_temp.reset_projection(:'user_id'::uuid);

-- ---------------------------------------------------------------------------
-- 5b. The daily retry window is a UTC interval, independent of session TZ
-- ---------------------------------------------------------------------------

insert into public.projection_sync_passes (user_id, snapshot, language_code, started_at)
values
  (:'user_id'::uuid, current_setting('test.snapshot')::timestamptz + interval '10 hours', 'fr', clock_timestamp()),
  (:'user_id'::uuid, current_setting('test.snapshot')::timestamptz + interval '11 hours', 'fr', clock_timestamp()),
  (:'user_id'::uuid, current_setting('test.snapshot')::timestamptz + interval '12 hours', 'fr', clock_timestamp()),
  (:'user_id'::uuid, current_setting('test.snapshot')::timestamptz + interval '13 hours', 'fr', clock_timestamp());

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);
set timezone = 'Asia/Seoul';

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz + interval '14 hours';
  v_over timestamptz := current_setting('test.snapshot')::timestamptz + interval '15 hours';
  v_detail text;
  v_retry int;
  v_expected numeric;
begin
  perform 1
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 2);
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', null, v_over, null, 2);
    raise exception 'a sixth daily snapshot was allowed';
  exception
    when sqlstate 'PT429' then
      get stacked diagnostics v_detail = pg_exception_detail;
  end;

  if v_detail is null or v_detail not like 'bucket=sync;retry_after_seconds=%' then
    raise exception 'daily denial detail is %', v_detail;
  end if;
  v_retry := split_part(v_detail, 'retry_after_seconds=', 2)::int;

  -- The denial must report the interval to the next UTC midnight, not a local
  -- midnight or a collapsed 1 second.
  v_expected := extract(epoch from (
    date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'
    + interval '1 day' - clock_timestamp()
  ));
  if v_retry <= 0 or abs(v_retry - v_expected) > 5 then
    raise exception 'retry_after_seconds is %, expected about % in Asia/Seoul', v_retry, v_expected;
  end if;
end $$;

reset timezone;
reset role;
select pg_temp.reset_projection(:'user_id'::uuid);

-- ---------------------------------------------------------------------------
-- 6. Bucket allowlist, fixed windows, and retention
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'third_user_id', false);

do $$
begin
  begin
    perform public.consume_projection_quota('evil_bucket', 60, 60);
    raise exception 'an arbitrary bucket was accepted';
  exception
    when sqlstate '22023' then null;
  end;
  begin
    perform public.consume_projection_quota('projection_page', 59, 60);
    raise exception 'a caller-chosen limit was accepted';
  exception
    when sqlstate '22023' then null;
  end;
  begin
    perform public.consume_projection_quota('projection_page', 60, 1);
    raise exception 'a caller-chosen window was accepted';
  exception
    when sqlstate '22023' then null;
  end;

  -- A full previous-minute window does not affect the current minute.
  reset role;
  insert into public.projection_usage (user_id, bucket, window_start, count)
  values (
    current_setting('test.third_user_id')::uuid,
    'projection_page',
    pg_temp.window_start(60) - interval '60 seconds',
    60
  );
  set role authenticated;

  if not public.consume_projection_quota('projection_page', 60, 60) then
    raise exception 'the fixed window did not reset at the minute boundary';
  end if;

  -- A previous-day window does not affect today's counter either.
  reset role;
  insert into public.projection_usage (user_id, bucket, window_start, count)
  values (
    current_setting('test.third_user_id')::uuid,
    'projection_page_resume',
    pg_temp.window_start(86400) - interval '1 day',
    2147483647
  );
  set role authenticated;
  if not public.consume_projection_quota('projection_page_resume', 2147483647, 86400) then
    raise exception 'the fixed window did not reset at the day boundary';
  end if;
end $$;

reset role;

-- Retention: old counter and pass rows are removed; recent ones stay.
insert into public.projection_usage (user_id, bucket, window_start, count)
values
  (:'fourth_user_id'::uuid, 'projection_page', clock_timestamp() - interval '30 days', 1),
  (:'fourth_user_id'::uuid, 'projection_page', pg_temp.window_start(60), 1);

insert into public.projection_sync_passes
  (user_id, snapshot, language_code, started_at, complete)
values
  (:'fourth_user_id'::uuid, clock_timestamp() - interval '40 days', 'fr', clock_timestamp() - interval '40 days', true),
  (:'fourth_user_id'::uuid, clock_timestamp(), 'fr', clock_timestamp(), false);

do $$
declare
  v_result jsonb;
  v_usage bigint;
  v_passes bigint;
begin
  v_result := public.prune_projection_usage(14);
  if (v_result->>'usage')::bigint < 1 or (v_result->>'passes')::bigint < 1 then
    raise exception 'prune reported %', v_result;
  end if;

  select count(*) into v_usage from public.projection_usage
  where user_id = current_setting('test.fourth_user_id')::uuid;
  if v_usage <> 1 then
    raise exception 'retention kept % usage rows, expected 1', v_usage;
  end if;

  select count(*) into v_passes from public.projection_sync_passes
  where user_id = current_setting('test.fourth_user_id')::uuid;
  if v_passes <> 1 then
    raise exception 'retention kept % pass rows, expected 1', v_passes;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'prune-projection-usage') then
      raise exception 'the projection usage retention job is not scheduled';
    end if;
  end if;
end $$;

-- A subject-less call reads nothing and consumes nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.get_wordbook_projection_page(
    'fr', null, current_setting('test.snapshot')::timestamptz, null, 10
  );
  if v_count <> 0 then
    raise exception 'a no-subject page request returned % rows', v_count;
  end if;
  if public.consume_projection_quota('projection_page', 60, 60) then
    raise exception 'a no-subject quota consume succeeded';
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 7. Cleanup
-- ---------------------------------------------------------------------------

delete from public.projection_usage
where user_id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);
delete from public.projection_sync_passes
where user_id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);
delete from public.projection_read_sessions
where user_id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);
delete from auth.users
where id in (
  :'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid, :'fourth_user_id'::uuid
);
