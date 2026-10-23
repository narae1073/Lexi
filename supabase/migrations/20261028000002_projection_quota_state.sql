-- Projection quota state machine and hardened pre-public metrics (R3, task 13
-- review).
--
-- This migration supersedes the quota wiring from 20261028000001 without
-- editing that applied migration:
--
--   1. The page RPC is SECURITY DEFINER and is the only way an authenticated
--      client can read `wordbook_entries`. Direct SELECT is revoked, so a
--      PostgREST range request cannot bypass the page quota.
--   2. Complete passes have server state per `(user, snapshot, language)`:
--      `last_cursor`, `previous_cursor`, `final_cursor`, `complete`. A new
--      pass must start with a null cursor; later pages must match the server's
--      cursor (one page back is accepted so a crash between storing rows and
--      the cursor can retry); a completed pass can only replay its final page.
--      An arbitrary cursor, a completed pass with another cursor, an empty
--      cursor, and the unbounded `p_snapshot = null` mode are rejected.
--   3. Daily counting is atomic: `consume_projection_sync` takes a per-user
--      transaction advisory lock and counts distinct snapshots started today,
--      so two concurrent first pages cannot both take the last daily unit.
--   4. `consume_projection_quota` accepts a fixed bucket allowlist with a
--      fixed limit/window per bucket. A client cannot create arbitrary bucket
--      or window rows. `prune_projection_usage` (scheduled with pg_cron when
--      present) keeps the table bounded.
--   5. `record_projection_usage` records rows read per page so the metrics
--      script can report a true 24-hour byte/page/egress window instead of
--      mixing cumulative pg_stat_statements with 24h counters.
--
-- The two daily limits are unchanged: 60 pages per user per minute and 2
-- complete projection syncs per user per UTC day.

-- ---------------------------------------------------------------------------
-- Complete-pass state
-- ---------------------------------------------------------------------------

-- The old shape had no language and no state. This is a pre-public table, so
-- replace it rather than migrate rows that cannot describe a resumable cursor.
drop function if exists public.consume_projection_sync(timestamptz);
drop table if exists public.projection_sync_passes;

create table public.projection_sync_passes (
  user_id         uuid        not null references auth.users on delete cascade,
  snapshot        timestamptz not null,
  language_code   text        not null,
  started_at      timestamptz not null default clock_timestamp(),
  last_cursor     text,
  previous_cursor text,
  final_cursor    text,
  complete        boolean     not null default false,
  primary key (user_id, snapshot, language_code)
);

comment on table public.projection_sync_passes is
  'Server state for one complete projection pass per (user, snapshot, language). Used for the 2/day limit, cursor validation, and first-sync metrics; clients cannot access it directly.';

create index projection_sync_passes_user_started_idx
  on public.projection_sync_passes (user_id, started_at);

alter table public.projection_sync_passes enable row level security;
revoke all on table public.projection_sync_passes from public, anon, authenticated;

-- Atomic daily charge. The per-user advisory transaction lock serializes the
-- distinct-snapshot count, so concurrent first pages with different snapshots
-- cannot both take the same last unit.
create or replace function public.consume_projection_sync(
  p_snapshot timestamptz,
  p_language_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_today timestamptz := date_trunc('day', clock_timestamp() at time zone 'utc')
    at time zone 'utc';
  v_started int;
begin
  if v_user_id is null
     or p_snapshot is null
     or p_language_code is null
     or p_language_code = '' then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('projection:' || v_user_id::text, 0));

  -- A snapshot already charged today is free: another language or a resumed
  -- page belongs to the same complete download. Refresh this language's row
  -- so a previous-day snapshot entering today is counted once.
  if exists (
    select 1 from public.projection_sync_passes
    where user_id = v_user_id
      and snapshot = p_snapshot
      and started_at >= v_today
  ) then
    insert into public.projection_sync_passes (user_id, snapshot, language_code, started_at)
    values (v_user_id, p_snapshot, p_language_code, clock_timestamp())
    on conflict (user_id, snapshot, language_code)
    do update set started_at = clock_timestamp();
    return true;
  end if;

  select count(distinct snapshot) into v_started
  from public.projection_sync_passes
  where user_id = v_user_id and started_at >= v_today;

  if v_started >= 2 then
    return false;
  end if;

  insert into public.projection_sync_passes (user_id, snapshot, language_code, started_at)
  values (v_user_id, p_snapshot, p_language_code, clock_timestamp())
  on conflict (user_id, snapshot, language_code)
  do update set started_at = clock_timestamp();

  return true;
end;
$$;

comment on function public.consume_projection_sync(timestamptz, text) is
  'Starts or resumes the authenticated caller''s pass for a snapshot/language under a per-user advisory lock. Returns false only for a new snapshot beyond the 2-per-UTC-day limit.';

revoke all on function public.consume_projection_sync(timestamptz, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixed bucket policy + retention
-- ---------------------------------------------------------------------------

-- Limits and windows are fixed per bucket. The caller still supplies
-- p_limit/p_window_seconds (the documented interface), but they must match the
-- policy exactly. A client can therefore never grow the table by inventing
-- buckets or choosing a one-second window.
create or replace function public.consume_projection_quota(
  p_bucket text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_expected_limit int;
  v_expected_window int;
  v_window timestamptz;
  v_count int;
begin
  if v_user_id is null then
    return false;
  end if;

  case p_bucket
    when 'projection_page' then
      v_expected_limit := 60;
      v_expected_window := 60;
    when 'projection_page_resume' then
      v_expected_limit := 2147483647;
      v_expected_window := 86400;
    when 'projection_quota_denied' then
      v_expected_limit := 2147483647;
      v_expected_window := 86400;
    when 'projection_quota_denied_sync' then
      v_expected_limit := 2147483647;
      v_expected_window := 86400;
    when 'projection_sync_complete' then
      v_expected_limit := 2147483647;
      v_expected_window := 86400;
    when 'projection_rows' then
      v_expected_limit := 2147483647;
      v_expected_window := 86400;
    else
      raise exception 'unknown projection quota bucket: %', p_bucket
        using errcode = '22023';
  end case;

  if p_limit is distinct from v_expected_limit
     or p_window_seconds is distinct from v_expected_window then
    raise exception 'bucket % must use limit % and window % seconds',
      p_bucket, v_expected_limit, v_expected_window
      using errcode = '22023';
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.projection_usage as usage (user_id, bucket, window_start, count)
  values (v_user_id, p_bucket, v_window, 1)
  on conflict (user_id, bucket, window_start)
  do update set count = usage.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

comment on function public.consume_projection_quota(text, int, int) is
  'Consumes one unit of the authenticated caller''s fixed-window bucket. Only the documented buckets are accepted, with a fixed limit/window per bucket. Derives the user from auth.uid(); never accepts a user id.';

revoke all on function public.consume_projection_quota(text, int, int)
  from public, anon, authenticated;
grant execute on function public.consume_projection_quota(text, int, int)
  to authenticated;

-- Row-count recording for the 24h pull byte estimate. Internal to the page
-- RPC: only `projection_rows` is accepted, so it cannot be used as a generic
-- counter writer.
create or replace function public.record_projection_usage(
  p_bucket text,
  p_units int,
  p_window_seconds int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_window timestamptz;
begin
  if v_user_id is null then
    return;
  end if;
  if p_bucket is distinct from 'projection_rows' or p_window_seconds is distinct from 86400 then
    raise exception 'invalid projection usage recording' using errcode = '22023';
  end if;
  if p_units is null or p_units < 0 then
    raise exception 'invalid projection usage units' using errcode = '22023';
  end if;
  if p_units = 0 then
    return;
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.projection_usage as usage (user_id, bucket, window_start, count)
  values (v_user_id, p_bucket, v_window, p_units)
  on conflict (user_id, bucket, window_start)
  do update set count = usage.count + excluded.count;
end;
$$;

comment on function public.record_projection_usage(text, int, int) is
  'Adds a page''s row count to the 24h projection_rows bucket. Internal to get_wordbook_projection_page.';

revoke all on function public.record_projection_usage(text, int, int)
  from public, anon, authenticated;

-- Retention: counters are useful for pre-public dashboards for two weeks;
-- pass state is useful while a client may still resume, so keep 30 days.
create or replace function public.prune_projection_usage(p_keep_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usage bigint;
  v_passes bigint;
begin
  if p_keep_days is null or p_keep_days < 1 then
    raise exception 'p_keep_days must be at least 1' using errcode = '22023';
  end if;

  delete from public.projection_usage
  where window_start < clock_timestamp() - make_interval(days => p_keep_days);
  get diagnostics v_usage = row_count;

  delete from public.projection_sync_passes
  where started_at < clock_timestamp() - make_interval(days => greatest(p_keep_days, 30));
  get diagnostics v_passes = row_count;

  return jsonb_build_object('usage', v_usage, 'passes', v_passes);
end;
$$;

comment on function public.prune_projection_usage(int) is
  'Deletes projection_usage rows older than p_keep_days and projection_sync_passes older than max(p_keep_days, 30). Scheduled by pg_cron when available.';

revoke all on function public.prune_projection_usage(int)
  from public, anon, authenticated;
grant execute on function public.prune_projection_usage(int) to service_role;

-- pg_cron is available in the local stack and on Supabase, but a fresh local
-- database does not install it. Try to install it; if the migration role is
-- not privileged, the retention function remains available to an operator.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension pg_cron;
    exception
      when others then null;
    end;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cron' and p.proname = 'schedule'
  ) then
    perform cron.schedule(
      'prune-projection-usage',
      '17 3 * * *',
      'select public.prune_projection_usage(14)'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- wordbook_entries: no direct client SELECT
--
-- The page RPC is the only read endpoint. Keeping the RLS policy means a
-- future accidental grant still cannot cross tenants; the RPC itself is
-- SECURITY DEFINER and filters explicitly by auth.uid().
-- ---------------------------------------------------------------------------

revoke select on table public.wordbook_entries from authenticated;

-- ---------------------------------------------------------------------------
-- get_wordbook_projection_page: definer read + server cursor state
-- ---------------------------------------------------------------------------

create or replace function public.get_wordbook_projection_page(
  p_language_code text,
  p_after_lemma text,
  p_snapshot timestamptz,
  p_updated_since timestamptz,
  p_limit int
)
returns setof public.wordbook_entries
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_page public.wordbook_entries[];
  v_retry_seconds int;
  v_count int;
  v_pass public.projection_sync_passes%rowtype;
  v_has_pass boolean := false;
  v_replay boolean := false;
  v_next_cursor text;
  v_today timestamptz := date_trunc('day', clock_timestamp() at time zone 'utc')
    at time zone 'utc';
begin
  if v_user_id is null then
    -- Preserve the read endpoint's contract: no subject means no rows, not an
    -- error and not a shared quota bucket.
    return;
  end if;
  if p_language_code is null or p_language_code = '' then
    return;
  end if;

  if p_snapshot is not null and p_updated_since is not null then
    raise exception 'pass p_snapshot for a full page or p_updated_since for an incremental page, not both'
      using errcode = '22023';
  end if;
  if p_snapshot is null and p_updated_since is null then
    raise exception 'a projection page needs p_snapshot or p_updated_since'
      using errcode = 'PT400';
  end if;
  if p_after_lemma = '' then
    raise exception 'p_after_lemma must be null or a non-empty lemma'
      using errcode = 'PT400';
  end if;

  -- Page budget first: a denied page must not spend the daily sync unit.
  if not public.consume_projection_quota('projection_page', 60, 60) then
    v_retry_seconds := greatest(
      1,
      ceil(60 - (extract(epoch from clock_timestamp()) % 60))::int
    );
    raise exception 'projection page quota exceeded'
      using errcode = 'PT429',
            detail = 'bucket=page;retry_after_seconds=' || v_retry_seconds::text,
            hint = 'Retry after the current one-minute window.';
  end if;

  if p_snapshot is not null then
    -- Serializes pass state and the daily distinct-snapshot count for this
    -- user. Re-entrant with consume_projection_sync's lock.
    perform pg_advisory_xact_lock(hashtextextended('projection:' || v_user_id::text, 0));

    select * into v_pass
    from public.projection_sync_passes
    where user_id = v_user_id
      and snapshot = p_snapshot
      and language_code = p_language_code;
    v_has_pass := found;

    if v_has_pass and v_pass.complete then
      -- The only legal retry of a completed pass is the final page again: a
      -- crash after the server stored complete but before the client stored
      -- the final rows must not lose them, and a different cursor must not
      -- silently skip rows.
      if p_after_lemma is not distinct from v_pass.final_cursor then
        v_replay := true;
      else
        raise exception 'projection pass is already complete; start a new snapshot'
          using errcode = 'PT409',
                detail = 'reason=complete';
      end if;
    elsif v_has_pass then
      -- A pass last touched on an earlier day is a complete sync for today.
      if v_pass.started_at < v_today then
        if not public.consume_projection_sync(p_snapshot, p_language_code) then
          v_retry_seconds := greatest(
            1,
            ceil(extract(epoch from (
              v_today + interval '1 day' - (clock_timestamp() at time zone 'utc')
            )))::int
          );
          raise exception 'projection complete-sync quota exceeded'
            using errcode = 'PT429',
                  detail = 'bucket=sync;retry_after_seconds=' || v_retry_seconds::text,
                  hint = 'The daily complete-projection limit resets at 00:00 UTC.';
        end if;
      end if;

      -- next page may follow last_cursor; a retry may use previous_cursor.
      -- null is accepted only while previous_cursor is null, which is the
      -- window before the first page was stored.
      if p_after_lemma is not null
         and p_after_lemma is distinct from v_pass.last_cursor
         and p_after_lemma is distinct from v_pass.previous_cursor then
        raise exception 'projection cursor does not match this pass'
          using errcode = 'PT409',
                detail = 'reason=cursor';
      end if;
      if p_after_lemma is null
         and v_pass.last_cursor is not null
         and v_pass.previous_cursor is not null then
        raise exception 'projection cursor does not match this pass'
          using errcode = 'PT409',
                detail = 'reason=cursor';
      end if;
    else
      -- A full pass must start at the first lemma. This is what stops a client
      -- from sending an arbitrary cursor (including '') to avoid the daily
      -- charge: the pass row is keyed by snapshot/language, so the first page
      -- of any language under a new snapshot is charged.
      if p_after_lemma is not null then
        raise exception 'a new projection pass must start at the first lemma'
          using errcode = 'PT409',
                detail = 'reason=start';
      end if;
      if not public.consume_projection_sync(p_snapshot, p_language_code) then
        v_retry_seconds := greatest(
          1,
          ceil(extract(epoch from (
            v_today + interval '1 day' - (clock_timestamp() at time zone 'utc')
          )))::int
        );
        raise exception 'projection complete-sync quota exceeded'
          using errcode = 'PT429',
                detail = 'bucket=sync;retry_after_seconds=' || v_retry_seconds::text,
                hint = 'The daily complete-projection limit resets at 00:00 UTC.';
      end if;
    end if;
  end if;

  select coalesce(
    array_agg(page_row::public.wordbook_entries order by page_row.language_code, page_row.lemma),
    '{}'::public.wordbook_entries[]
  )
  into v_page
  from (
    select e.*
    from public.wordbook_entries e
    where e.user_id = v_user_id
      and e.language_code = p_language_code
      and (p_after_lemma is null or e.lemma > p_after_lemma)
      and (
        p_snapshot is null
        or (e.server_updated_at <= p_snapshot and e.deleted_at is null)
      )
      and (p_updated_since is null or e.server_updated_at > p_updated_since)
    order by e.language_code, e.lemma
    limit v_limit
  ) as page_row;
  v_count := coalesce(array_length(v_page, 1), 0);

  if p_snapshot is not null and not v_replay then
    if v_count < v_limit then
      update public.projection_sync_passes
      set complete = true,
          final_cursor = p_after_lemma,
          previous_cursor = p_after_lemma
      where user_id = v_user_id
        and snapshot = p_snapshot
        and language_code = p_language_code;
      perform public.consume_projection_quota(
        'projection_sync_complete', 2147483647, 86400
      );
    else
      v_next_cursor := (v_page[array_length(v_page, 1)]).lemma;
      update public.projection_sync_passes
      set last_cursor = v_next_cursor,
          previous_cursor = p_after_lemma,
          complete = false
      where user_id = v_user_id
        and snapshot = p_snapshot
        and language_code = p_language_code;
    end if;
  end if;

  if p_after_lemma is not null then
    perform public.consume_projection_quota('projection_page_resume', 2147483647, 86400);
  end if;

  perform public.record_projection_usage('projection_rows', v_count, 86400);

  return query select * from unnest(v_page);
end;
$$;

comment on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int) is
  'One resumable wordbook projection page. SECURITY DEFINER with an explicit auth.uid() filter; charges the page quota, enforces server-side pass state for full pages, and charges at most 2 complete syncs per UTC day. p_snapshot: full page, live rows only. p_updated_since: incremental page, soft deletions included. Exactly one bound per call; both null is rejected.';

revoke all on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  to authenticated;
