-- Projection pull quotas (R3, task 13).
--
-- Pre-public limits, per account and per fixed window:
--
--   * 60 projection pages per user per one-minute window;
--   * 2 complete projection syncs per user per UTC day.
--
-- Both are deliberately small. A page is up to 1000 rows (the ceiling from
-- 20261027000004); at the R3 fixture's measured row size (~830 B average,
-- ~1.5 KB maximum) a full page is about 1 MB, which is the response-size
-- target the client and this quota are sized for. A caller that needs a hard
-- 1 MB cap asks for a smaller `p_limit`; the row count remains the only
-- end-of-language signal, so the server never truncates a page by bytes.
--
-- What counts as a complete sync
--   A full pass is identified by its snapshot. The first page of any language
--   under a snapshot starts one pass row; the first page of the next language
--   under the same snapshot, and every later page (which carries a cursor),
--   are the same pass and do not spend another daily unit. A manual reset or a
--   new account starts a new snapshot and therefore spends one. An incremental
--   pass (`p_updated_since`) is not a complete download and never spends one.
--   Because the daily count is by distinct snapshot, two languages in one
--   first sync still use exactly one of the two daily units.
--
-- Window semantics
--   Fixed windows floored on the UTC epoch, like consume_function_quota. A
--   quota decision is made by the page RPC, which raises on denial; PostgreSQL
--   rolls the transaction (and therefore the increment that crossed the limit)
--   back, so a denied request leaves the committed counter at the limit rather
--   than above it. Retrying cannot shrink a window and cannot touch another
--   account's row. The client records each denial best-effort in the separate
--   `projection_quota_denied` bucket for the pre-public 429 metric.
--
-- RLS safety
--   `projection_usage` and `projection_sync_passes` have RLS enabled and no
--   policy, and every client grant is revoked. Both consume helpers are
--   security definer with a pinned search_path and derive the row key from
--   `auth.uid()`; they accept no user id, so a caller cannot touch another
--   account's row. A subject-less call returns false rather than sharing a
--   null-user bucket.
--
-- The counters are also the pre-public metrics source in
-- `scripts/r3-metrics.mjs`: `projection_page_resume` counts resumed pages and
-- `projection_quota_denied` counts 429s. `projection_sync_passes` identifies a
-- complete pass by its snapshot (so several languages and every resumed page
-- belong to one pass), and `projection_sync_complete` counts finished full
-- language passes (a first-sync proxy).

create table public.projection_usage (
  user_id      uuid        not null references auth.users on delete cascade,
  bucket       text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (user_id, bucket, window_start)
);

comment on table public.projection_usage is
  'Per-user fixed-window counters for projection pull quotas and pull metrics. Clients cannot read or write it directly.';

-- Supports the metrics script's rolling-window aggregation and any later
-- retention job (`delete ... where window_start < ...`); only the primary key
-- can serve one user's consume path.
create index projection_usage_window_idx on public.projection_usage (window_start);

alter table public.projection_usage enable row level security;
-- No policy on purpose: only the definer-owned consume function may write, and
-- only the database owner / service role reads it for metrics.
revoke all on table public.projection_usage from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- consume_projection_quota
--
-- Atomically consumes one unit from the caller's `(bucket, window)` counter and
-- reports whether the caller is still inside the limit. The insert/on-conflict
-- is one statement, so concurrent requests cannot both read a stale count.
-- ---------------------------------------------------------------------------

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
  v_window timestamptz;
  v_count int;
begin
  if v_user_id is null then
    return false;
  end if;

  -- Metrics buckets are part of this table, but an unbounded caller-chosen
  -- bucket name would let one account create unlimited rows. Keep names to a
  -- small, documented vocabulary shape.
  if p_bucket is null or p_bucket !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid projection quota bucket'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit <= 0 or p_window_seconds is null or p_window_seconds <= 0 then
    return false;
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
  'Consumes one unit of the authenticated caller''s fixed-window bucket and returns whether it is within p_limit. Derives the user from auth.uid(); never accepts a user id.';

revoke all on function public.consume_projection_quota(text, int, int)
  from public, anon, authenticated;
grant execute on function public.consume_projection_quota(text, int, int)
  to authenticated;

-- ---------------------------------------------------------------------------
-- projection_sync_passes: identity of one complete projection pass
--
-- The page RPC sees one language at a time, so it cannot tell "the first page
-- of a new complete sync" from "the first page of the second language in the
-- same sync" by p_after_lemma alone. A pass is identified by its snapshot:
-- every language and every resumed page of one download shares it.
--
-- The first full page of a snapshot records one row. Later languages and
-- resumed pages under the same snapshot are resumes, not new daily units. A
-- pass last started on an earlier day is charged once for the new day. The
-- daily limit counts rows started today, so exactly two distinct snapshots
-- start a complete sync per UTC day. A denied pass rolls back with its
-- exception.
-- ---------------------------------------------------------------------------

create table public.projection_sync_passes (
  user_id    uuid        not null references auth.users on delete cascade,
  snapshot   timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),
  primary key (user_id, snapshot)
);

comment on table public.projection_sync_passes is
  'One row per started complete projection pass (per user snapshot). Used for the 2/day limit and first-sync metrics; clients cannot access it directly.';

create index projection_sync_passes_user_started_idx
  on public.projection_sync_passes (user_id, started_at);

alter table public.projection_sync_passes enable row level security;
revoke all on table public.projection_sync_passes from public, anon, authenticated;

-- Returns false only when this call starts a new pass beyond today's limit.
-- An already-started snapshot always returns true: it is a resume or another
-- language of the same pass, and must not consume a second daily unit.
create or replace function public.consume_projection_sync(p_snapshot timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_today timestamptz := date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc';
  v_previous timestamptz;
  v_started int;
begin
  if v_user_id is null or p_snapshot is null then
    return false;
  end if;

  select started_at into v_previous
  from public.projection_sync_passes
  where user_id = v_user_id and snapshot = p_snapshot;

  -- A pass started earlier today is a resume (another language, a paused
  -- pass): it does not spend a second unit. A snapshot first seen on an
  -- earlier day is a new day's complete sync and is charged once today.
  if v_previous is not null and v_previous >= v_today then
    return true;
  end if;

  insert into public.projection_sync_passes (user_id, snapshot, started_at)
  values (v_user_id, p_snapshot, clock_timestamp())
  on conflict (user_id, snapshot)
  do update set started_at = clock_timestamp();

  select count(*) into v_started
  from public.projection_sync_passes
  where user_id = v_user_id and started_at >= v_today;

  return v_started <= 2;
end;
$$;

comment on function public.consume_projection_sync(timestamptz) is
  'Starts (or recognizes) the authenticated caller''s projection pass for a snapshot. Returns false only for a new pass beyond the 2-per-UTC-day limit.';

revoke all on function public.consume_projection_sync(timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_projection_sync(timestamptz)
  to authenticated;

-- ---------------------------------------------------------------------------
-- get_wordbook_projection_page: charge the quota before reading rows
--
-- Same paging contract as 20261027000004 (snapshot full page / watermark
-- incremental page, 1000-row ceiling). The function becomes VOLATILE because
-- it now writes counters; it remains SECURITY INVOKER, so RLS still bounds the
-- rows it returns to auth.uid().
--
-- A denial raises SQLSTATE PT429 (PostgREST maps it to HTTP 429) with a
-- machine-readable detail:
--     bucket=page;retry_after_seconds=<n>
--     bucket=sync;retry_after_seconds=<n>
-- The client maps that to a recoverable ProjectionQuotaError and backs off.
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
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_page public.wordbook_entries[];
  v_retry_seconds int;
  v_complete int;
begin
  if v_user_id is null then
    -- Preserve the read endpoint's contract: no subject means no rows, not an
    -- error and not a shared quota bucket.
    return;
  end if;

  if p_snapshot is not null and p_updated_since is not null then
    raise exception 'pass p_snapshot for a full page or p_updated_since for an incremental page, not both'
      using errcode = '22023';
  end if;

  -- Page budget first: a denied page must not spend the daily sync unit, and a
  -- resume must not be charged again. 60 pages per fixed one-minute window.
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

  -- Only the first page of a full pass can start a new complete sync. A
  -- resumed page carries a cursor; an incremental watermark is not a complete
  -- sync at all. The helper recognizes a second language or a resumed page
  -- under the same snapshot as the same pass.
  if p_snapshot is not null and p_after_lemma is null then
    if not public.consume_projection_sync(p_snapshot) then
      v_retry_seconds := greatest(
        1,
        ceil(extract(epoch from (
          date_trunc('day', clock_timestamp() at time zone 'utc') + interval '1 day'
          - (clock_timestamp() at time zone 'utc')
        )))::int
      );
      raise exception 'projection complete-sync quota exceeded'
        using errcode = 'PT429',
              detail = 'bucket=sync;retry_after_seconds=' || v_retry_seconds::text,
              hint = 'The daily complete-projection limit resets at 00:00 UTC.';
    end if;
  elsif p_after_lemma is not null then
    -- A resumed page (a cursor was supplied). Counted for metrics only.
    perform public.consume_projection_quota('projection_page_resume', 2147483647, 86400);
  end if;

  select coalesce(array_agg(page_row::public.wordbook_entries), '{}'::public.wordbook_entries[])
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

  -- A short full page is the end of this language's full pass. The counter is
  -- a per-user first-sync proxy for the metrics snapshot; it never gates a
  -- request.
  v_complete := coalesce(array_length(v_page, 1), 0);
  if p_snapshot is not null and v_complete < v_limit then
    perform public.consume_projection_quota('projection_sync_complete', 2147483647, 86400);
  end if;

  return query select * from unnest(v_page);
end;
$$;

comment on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int) is
  'One resumable wordbook projection page for the caller, after charging the per-user page quota and, for the first page of a new complete pass, that pass against the 2-per-UTC-day limit. p_snapshot: full page, live rows only. p_updated_since: incremental page, soft deletions included. Exactly one bound per call.';

revoke all on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  to authenticated;
