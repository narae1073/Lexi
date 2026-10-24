-- Projection quota follow-up: 5 complete downloads per UTC day and reuse of
-- the day's recent projection snapshot for fresh clients.
--
-- The old 5-argument page RPC remains in place for older R3 clients. New
-- clients call the 6-argument overload with a session id obtained from
-- `begin_projection_read`. A session owns its cursor state, so two devices can
-- read the same snapshot independently without resetting each other's pass.
--
-- Daily accounting stays per account and per distinct snapshot. A fresh
-- browser/cache clear obtains a new session for the same snapshot and does not
-- spend a second daily unit. The page-rate limit (60/minute) and byte budget
-- are unchanged.

-- ---------------------------------------------------------------------------
-- Raise the old path's daily limit from 2 to 5.
-- ---------------------------------------------------------------------------

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
     or p_language_code = ''
     or p_language_code !~ '^[a-z]{2}(-[A-Za-z]{2})?$' then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('projection:' || v_user_id::text, 0));

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

  if v_started >= 5 then
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
  'Starts or resumes the authenticated caller''s pass for a snapshot/language under a per-user advisory lock. Returns false only for a new snapshot beyond the 5-per-UTC-day limit.';

revoke all on function public.consume_projection_sync(timestamptz, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reused-snapshot session state
-- ---------------------------------------------------------------------------

create table public.projection_read_sessions (
  user_id         uuid        not null references auth.users on delete cascade,
  session_id      uuid        not null,
  snapshot        timestamptz not null,
  language_code   text        not null,
  started_at      timestamptz not null default clock_timestamp(),
  last_cursor     text,
  previous_cursor text,
  final_cursor    text,
  complete        boolean     not null default false,
  primary key (user_id, session_id, language_code)
);

comment on table public.projection_read_sessions is
  'Per-client cursor state for a projection snapshot. Multiple sessions may read the same account snapshot; each has independent resume state.';

create index projection_read_sessions_user_snapshot_idx
  on public.projection_read_sessions (user_id, snapshot);

alter table public.projection_read_sessions enable row level security;
revoke all on table public.projection_read_sessions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Start a reusable projection read
--
-- Reuse the latest snapshot charged today. If there is none, use the current
-- clock; the first page will charge that new snapshot. `p_force_new` is for an
-- explicit manual full resync, which must not silently reuse stale data.
-- ---------------------------------------------------------------------------

create or replace function public.begin_projection_read(
  p_force_new boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_snapshot timestamptz;
  v_reused boolean := false;
begin
  if v_user_id is null then
    return null;
  end if;

  if not p_force_new then
    select snapshot into v_snapshot
    from public.projection_sync_passes
    where user_id = v_user_id
      and started_at >= date_trunc('day', clock_timestamp() at time zone 'utc')
        at time zone 'utc'
    order by started_at desc
    limit 1;
    v_reused := found;
  end if;

  if v_snapshot is null then
    v_snapshot := clock_timestamp();
  end if;

  return jsonb_build_object(
    'snapshot', v_snapshot,
    'sessionId', gen_random_uuid(),
    'reused', v_reused
  );
end;
$$;

comment on function public.begin_projection_read(boolean) is
  'Returns the recent snapshot charged today (or a new clock snapshot when forced/none exists) and a fresh per-client session id.';

revoke all on function public.begin_projection_read(boolean)
  from public, anon, authenticated;
grant execute on function public.begin_projection_read(boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Daily charge for the reusable path
-- ---------------------------------------------------------------------------

create or replace function public.consume_projection_snapshot(
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
     or p_language_code = ''
     or p_language_code !~ '^[a-z]{2}(-[A-Za-z]{2})?$' then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('projection:' || v_user_id::text, 0));

  -- The snapshot already has a row today: another language, session, or a
  -- resumed pass. It is free.
  if exists (
    select 1 from public.projection_sync_passes
    where user_id = v_user_id
      and snapshot = p_snapshot
      and started_at >= v_today
  ) then
    return true;
  end if;

  select count(distinct snapshot) into v_started
  from public.projection_sync_passes
  where user_id = v_user_id and started_at >= v_today;

  if v_started >= 5 then
    return false;
  end if;

  insert into public.projection_sync_passes (user_id, snapshot, language_code, started_at)
  values (v_user_id, p_snapshot, p_language_code, clock_timestamp())
  on conflict (user_id, snapshot, language_code)
  do update set started_at = clock_timestamp();

  return true;
end;
$$;

comment on function public.consume_projection_snapshot(timestamptz, text) is
  'Charges a distinct snapshot to the authenticated account at most once per UTC day under the 5/day limit. Used by reusable read sessions.';

revoke all on function public.consume_projection_snapshot(timestamptz, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Six-argument reusable page overload
--
-- The five-argument function remains for older clients. This function is only
-- for full snapshot pages; incremental pages continue through the old RPC.
-- ---------------------------------------------------------------------------

create or replace function public.get_wordbook_projection_page_bounded(
  p_language_code text,
  p_after_lemma text,
  p_snapshot timestamptz,
  p_updated_since timestamptz,
  p_limit int,
  p_session_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_byte_budget constant bigint := 1048576;
  v_candidates public.wordbook_entries[];
  v_page public.wordbook_entries[] := '{}'::public.wordbook_entries[];
  v_row public.wordbook_entries%rowtype;
  v_row_bytes bigint;
  v_page_bytes bigint := 0;
  v_count int := 0;
  v_candidate_count int := 0;
  v_has_more boolean := false;
  v_last_lemma text;
  v_retry_seconds int;
  v_session public.projection_read_sessions%rowtype;
  v_has_session boolean := false;
  v_replay boolean := false;
  v_today timestamptz := date_trunc('day', clock_timestamp() at time zone 'utc')
    at time zone 'utc';
begin
  if v_user_id is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'hasMore', false, 'nextCursor', null);
  end if;
  if p_language_code is null or p_language_code = '' then
    return jsonb_build_object('rows', '[]'::jsonb, 'hasMore', false, 'nextCursor', null);
  end if;
  if p_language_code !~ '^[a-z]{2}(-[A-Za-z]{2})?$' then
    raise exception 'invalid projection language code' using errcode = 'PT400';
  end if;
  if p_snapshot is null or p_updated_since is not null then
    raise exception 'reusable projection pages require p_snapshot and no p_updated_since'
      using errcode = '22023';
  end if;
  if p_session_id is null then
    raise exception 'reusable projection pages require a session id'
      using errcode = '22023';
  end if;
  if p_after_lemma = '' then
    raise exception 'p_after_lemma must be null or a non-empty lemma'
      using errcode = 'PT400';
  end if;

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

  perform pg_advisory_xact_lock(hashtextextended('projection:' || v_user_id::text, 0));

  select * into v_session
  from public.projection_read_sessions
  where user_id = v_user_id
    and session_id = p_session_id
    and language_code = p_language_code;
  v_has_session := found;

  if not v_has_session then
    if p_after_lemma is not null then
      raise exception 'a new projection read must start at the first lemma'
        using errcode = 'PT409',
              detail = 'reason=start';
    end if;

    if not public.consume_projection_snapshot(p_snapshot, p_language_code) then
      v_retry_seconds := greatest(
        1,
        ceil(extract(epoch from (v_today + interval '1 day' - clock_timestamp())))::int
      );
      raise exception 'projection complete-sync quota exceeded'
        using errcode = 'PT429',
              detail = 'bucket=sync;retry_after_seconds=' || v_retry_seconds::text,
              hint = 'The daily complete-projection limit resets at 00:00 UTC.';
    end if;

    insert into public.projection_read_sessions
      (user_id, session_id, snapshot, language_code, started_at)
    values
      (v_user_id, p_session_id, p_snapshot, p_language_code, clock_timestamp());
  else
    if v_session.snapshot is distinct from p_snapshot then
      raise exception 'projection read session belongs to another snapshot'
        using errcode = 'PT409',
              detail = 'reason=start';
    end if;

    if v_session.complete then
      if p_after_lemma is distinct from v_session.final_cursor then
        raise exception 'projection pass is already complete; start a new snapshot'
          using errcode = 'PT409',
                detail = 'reason=complete';
      end if;
      v_replay := true;
    elsif p_after_lemma is null then
      update public.projection_read_sessions
      set last_cursor = null,
          previous_cursor = null
      where user_id = v_user_id
        and session_id = p_session_id
        and language_code = p_language_code;
    elsif p_after_lemma is distinct from v_session.last_cursor
       and p_after_lemma is distinct from v_session.previous_cursor then
      raise exception 'projection cursor does not match this pass'
        using errcode = 'PT409',
              detail = 'reason=cursor';
    end if;
  end if;

  select coalesce(
    array_agg(c.row_value order by (c.row_value).language_code, (c.row_value).lemma),
    '{}'::public.wordbook_entries[]
  )
  into v_candidates
  from (
    select e as row_value
    from public.wordbook_entries e
    where e.user_id = v_user_id
      and e.language_code = p_language_code
      and (p_after_lemma is null or e.lemma > p_after_lemma)
      and e.server_updated_at <= p_snapshot
      and e.deleted_at is null
    order by e.language_code, e.lemma
    limit v_limit
  ) as c;

  v_candidate_count := coalesce(array_length(v_candidates, 1), 0);

  if v_candidate_count > 0 then
    foreach v_row in array v_candidates loop
      v_row_bytes := octet_length(row_to_json(v_row)::text);
      exit when v_count > 0 and v_page_bytes + v_row_bytes > v_byte_budget;
      v_page := array_append(v_page, v_row);
      v_page_bytes := v_page_bytes + v_row_bytes;
      v_count := v_count + 1;
      v_last_lemma := v_row.lemma;
    end loop;
  end if;

  if v_count < v_candidate_count then
    v_has_more := true;
  elsif v_candidate_count = v_limit then
    select exists (
      select 1
      from public.wordbook_entries e
      where e.user_id = v_user_id
        and e.language_code = p_language_code
        and e.lemma > v_last_lemma
        and e.server_updated_at <= p_snapshot
        and e.deleted_at is null
    )
    into v_has_more;
  end if;

  if not v_replay then
    if not v_has_more then
      update public.projection_read_sessions
      set complete = true,
          final_cursor = p_after_lemma,
          previous_cursor = p_after_lemma
      where user_id = v_user_id
        and session_id = p_session_id
        and language_code = p_language_code;
      perform public.consume_projection_quota(
        'projection_sync_complete', 2147483647, 86400
      );
    else
      update public.projection_read_sessions
      set last_cursor = v_last_lemma,
          previous_cursor = p_after_lemma,
          complete = false
      where user_id = v_user_id
        and session_id = p_session_id
        and language_code = p_language_code;
    end if;
  end if;

  if p_after_lemma is not null then
    perform public.consume_projection_quota('projection_page_resume', 2147483647, 86400);
  end if;

  perform public.record_projection_usage('projection_rows', v_count, 86400);

  return jsonb_build_object(
    'rows', coalesce(to_jsonb(v_page), '[]'::jsonb),
    'hasMore', v_has_more,
    'nextCursor', case when v_count > 0 then v_last_lemma else p_after_lemma end
  );
end;
$$;

comment on function public.get_wordbook_projection_page_bounded(text, text, timestamptz, timestamptz, int, uuid) is
  'Reusable snapshot page with its own per-client cursor session. Charges a distinct snapshot at most once in the 5-per-UTC-day account budget; page limits and byte bounds are unchanged.';

revoke all on function public.get_wordbook_projection_page_bounded(text, text, timestamptz, timestamptz, int, uuid)
  from public, anon, authenticated;
grant execute on function public.get_wordbook_projection_page_bounded(text, text, timestamptz, timestamptz, int, uuid)
  to authenticated;
