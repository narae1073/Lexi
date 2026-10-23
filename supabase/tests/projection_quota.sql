-- Projection pull quotas: per-user buckets, RLS, and the page RPC boundary.
--
-- Run after `npx supabase db reset` (or after applying all migrations):
--   docker exec -i supabase_db_translator psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/projection_quota.sql
--
-- The page RPC uses the production defaults (60 pages per minute, 2 complete
-- syncs per UTC day). To stay deterministic without issuing 60 requests, the
-- fixture pre-seeds the current fixed window's counter as the database owner
-- and then lets the real consume path move it across the limit. Counter rows
-- are seeded and asserted as postgres; every page request runs as
-- `authenticated` with request.jwt.claim.sub set, exactly like a client.

\set user_id '00000000-0000-4000-8000-00000000f001'
\set other_user_id '00000000-0000-4000-8000-00000000f002'
\set third_user_id '00000000-0000-4000-8000-00000000f003'
\set snapshot '2026-10-28 12:00:00+00'

select set_config('test.user_id', :'user_id', false);
select set_config('test.other_user_id', :'other_user_id', false);
select set_config('test.third_user_id', :'third_user_id', false);
select set_config('test.snapshot', :'snapshot', false);

-- Fail with a readable message while the migration is still missing.
do $$
begin
  if to_regprocedure('public.consume_projection_quota(text, int, int)') is null then
    raise exception 'consume_projection_quota(text, int, int) is missing';
  end if;
  if to_regclass('public.projection_usage') is null then
    raise exception 'public.projection_usage is missing';
  end if;
end $$;

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
      'consume_projection_quota',
      'consume_projection_sync'
    )
    and (
      -- The page function reads rows as the caller; only the quota writers are
      -- definer-owned. None may run with an unpinned search_path.
      (p.proname = 'get_wordbook_projection_page' and p.prosecdef)
      or (p.proname <> 'get_wordbook_projection_page' and not p.prosecdef)
      or not (p.proconfig @> array['search_path=public, pg_temp'])
      or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
    );
  if v_bad is not null then
    raise exception 'projection quota functions are missing, definer-based, or wrongly granted: %',
      v_bad;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.projection_usage'::regclass) then
    raise exception 'projection_usage does not have RLS enabled';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.projection_sync_passes'::regclass) then
    raise exception 'projection_sync_passes does not have RLS enabled';
  end if;

  -- No client role may touch the counters directly: the consumable API is the
  -- function, and every read is a metrics/owner concern.
  if has_table_privilege('authenticated', 'public.projection_usage', 'SELECT')
     or has_table_privilege('authenticated', 'public.projection_usage', 'INSERT')
     or has_table_privilege('authenticated', 'public.projection_usage', 'UPDATE')
     or has_table_privilege('authenticated', 'public.projection_usage', 'DELETE')
     or has_table_privilege('anon', 'public.projection_usage', 'SELECT')
     or has_table_privilege('authenticated', 'public.projection_sync_passes', 'SELECT')
     or has_table_privilege('authenticated', 'public.projection_sync_passes', 'INSERT')
     or has_table_privilege('anon', 'public.projection_sync_passes', 'SELECT') then
    raise exception 'projection quota tables are directly readable or writable by a client role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

delete from public.projection_usage
where user_id in (:'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid);
delete from auth.users
where id in (:'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  (:'user_id'::uuid, 'authenticated', 'authenticated', 'quota-a@example.test', now(), now(), now()),
  (:'other_user_id'::uuid, 'authenticated', 'authenticated', 'quota-b@example.test', now(), now(), now()),
  (:'third_user_id'::uuid, 'authenticated', 'authenticated', 'quota-c@example.test', now(), now(), now());

alter table public.wordbook_entries disable trigger wordbook_entries_server_updated_at;

insert into public.wordbook_entries (user_id, language_code, lemma, server_updated_at)
values
  (:'user_id'::uuid, 'fr', 'alpha', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'user_id'::uuid, 'fr', 'beta', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'other_user_id'::uuid, 'fr', 'alpha', current_setting('test.snapshot')::timestamptz - interval '1 minute'),
  (:'other_user_id'::uuid, 'fr', 'beta', current_setting('test.snapshot')::timestamptz - interval '1 minute');

alter table public.wordbook_entries enable trigger wordbook_entries_server_updated_at;

-- Fixed windows, computed exactly as the function does.
create or replace function pg_temp.window_start(p_seconds int)
returns timestamptz
language sql
stable
as $$
  select to_timestamp(floor(extract(epoch from clock_timestamp()) / p_seconds) * p_seconds);
$$;

-- ---------------------------------------------------------------------------
-- 1. RLS: a client cannot read or forge counters, but can consume its own
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
begin
  begin
    perform 1 from public.projection_usage limit 1;
    raise exception 'authenticated read projection_usage directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.projection_usage (user_id, bucket, window_start, count)
    values (current_setting('test.user_id')::uuid, 'projection_page', now(), 0);
    raise exception 'authenticated wrote projection_usage directly';
  exception
    when insufficient_privilege then null;
  end;

  if not public.consume_projection_quota('projection_page', 5, 60) then
    raise exception 'the caller''s own quota could not be consumed';
  end if;
end $$;

reset role;

set role anon;
do $$
begin
  begin
    perform public.consume_projection_quota('projection_page', 1, 60);
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

-- The direct consume above was a real count for the owner.
delete from public.projection_usage
where user_id = :'user_id'::uuid and bucket = 'projection_page';

-- ---------------------------------------------------------------------------
-- 2. Page budget: under the limit passes, the next request is a typed 429
-- ---------------------------------------------------------------------------

insert into public.projection_usage (user_id, bucket, window_start, count)
values (
  :'user_id'::uuid,
  'projection_page',
  pg_temp.window_start(60),
  59
);

set role authenticated;
select set_config('request.jwt.claim.sub', :'user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_count int;
  v_detail text;
  v_hint text;
begin
  -- The 60th page of this window is allowed.
  select count(*) into v_count
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 100);
  if v_count <> 2 then
    raise exception 'allowed page returned % rows, expected 2', v_count;
  end if;

  -- The 61st is denied before any row is returned, with a machine-readable
  -- bucket and a positive retry window.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 100);
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

-- ---------------------------------------------------------------------------
-- 3. Daily complete-sync budget: one unit per new snapshot, per UTC day
-- ---------------------------------------------------------------------------

delete from public.projection_usage where user_id = :'other_user_id'::uuid;
delete from public.projection_sync_passes where user_id = :'other_user_id'::uuid;

-- One complete pass was already started today.
insert into public.projection_sync_passes (user_id, snapshot, started_at)
values (:'other_user_id'::uuid, '2026-10-27 00:00:00+00', clock_timestamp());

set role authenticated;
select set_config('request.jwt.claim.sub', :'other_user_id', false);

do $$
declare
  v_snapshot timestamptz := current_setting('test.snapshot')::timestamptz;
  v_other_snapshot timestamptz := current_setting('test.snapshot')::timestamptz + interval '1 hour';
  v_detail text;
begin
  -- The second complete pass of the day: allowed.
  perform 1
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 100);

  -- A second language (or a retry) under the same snapshot is the same pass,
  -- not a third daily unit.
  perform 1
  from public.get_wordbook_projection_page('fr', null, v_snapshot, null, 100);

  -- A distinct snapshot is a third complete sync: denied.
  begin
    perform 1
    from public.get_wordbook_projection_page('fr', null, v_other_snapshot, null, 100);
    raise exception 'a third complete projection sync in one day was allowed';
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

  -- A resumed pass carries a cursor and reuses its snapshot.
  perform 1
  from public.get_wordbook_projection_page('fr', 'alpha', v_snapshot, null, 100);

  -- An incremental pass is not a complete sync either.
  perform 1
  from public.get_wordbook_projection_page('fr', null, null, v_snapshot, 100);
end $$;

reset role;

do $$
declare
  v_sync_count int;
  v_complete_count int;
begin
  -- The denied pass was rolled back with its exception; the allowed snapshot
  -- and the seeded prior pass remain.
  select count(*) into v_sync_count
  from public.projection_sync_passes
  where user_id = current_setting('test.other_user_id')::uuid
    and started_at >= (
      date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'
    );
  if v_sync_count <> 2 then
    raise exception 'the daily pass count is %, expected 2 after one denial', v_sync_count;
  end if;

  -- A finished full language pass is recorded for first-sync metrics.
  select coalesce(sum(count), 0) into v_complete_count
  from public.projection_usage
  where user_id = current_setting('test.other_user_id')::uuid
    and bucket = 'projection_sync_complete';
  if v_complete_count < 1 then
    raise exception 'a completed full pass was not recorded for first-sync metrics';
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. Fixed windows reset, and the reset belongs to one user
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', :'third_user_id', false);

do $$
begin
  -- Align to a 2-second boundary so the two calls cannot straddle it.
  perform pg_sleep(
    greatest(
      0,
      2 - (extract(epoch from clock_timestamp())::numeric % 2) + 0.05
    )
  );
  if not public.consume_projection_quota('projection_page', 1, 2) then
    raise exception 'the first request of a fresh window was denied';
  end if;
  if public.consume_projection_quota('projection_page', 1, 2) then
    raise exception 'the second request of the same window was allowed';
  end if;

  perform pg_sleep(2.05);

  if not public.consume_projection_quota('projection_page', 1, 2) then
    raise exception 'the counter did not reset at the window boundary';
  end if;
end $$;

reset role;

do $$
declare
  v_count int;
begin
  select coalesce(sum(count), 0) into v_count
  from public.projection_usage
  where user_id = current_setting('test.third_user_id')::uuid
    and bucket = 'projection_page';
  if v_count <> 3 then
    raise exception 'window counters summed to %, expected 3 (1 + 1 + 1 in fresh windows)', v_count;
  end if;
end $$;

-- A subject-less call returns no rows instead of sharing a null-user bucket.
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

  if public.consume_projection_quota('projection_page', 1, 60) then
    raise exception 'a no-subject quota consume succeeded';
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 5. Cleanup
-- ---------------------------------------------------------------------------

delete from public.projection_usage
where user_id in (:'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid);
delete from auth.users
where id in (:'user_id'::uuid, :'other_user_id'::uuid, :'third_user_id'::uuid);
