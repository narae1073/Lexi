-- Byte-bounded projection pages and interrupted-pass restart (R3 final review).
--
-- 1. `get_wordbook_projection_page_bounded` returns an explicit object:
--      { rows, hasMore, nextCursor }
--    A page is capped at both 1000 rows and roughly 1 MiB of serialized JSON.
--    A row larger than the whole budget is still returned on its own — capping
--    must never silently drop a lemma. Because a byte-truncated page is shorter
--    than the row limit, `hasMore` (not `rows.length < limit`) is the only
--    correct end-of-language signal.
--
-- 2. The original `get_wordbook_projection_page` becomes a set-returning
--    wrapper over the bounded function. Older clients and SQL tests keep their
--    signature, while every authenticated read is byte-bounded.
--
-- 3. An interrupted first projection can restart the *same* snapshot from lemma
--    0 even if a later page was already processed server-side. The client
--    persists the snapshot before its first page, so this restart reuses the
--    daily charge instead of spending a new snapshot. Re-reading is idempotent;
--    a completed pass still cannot rewind (its final page is the only replay).
--
-- Limits are unchanged: 1000 rows, 60 pages/minute, 2 complete passes/day.

create or replace function public.get_wordbook_projection_page_bounded(
  p_language_code text,
  p_after_lemma text,
  p_snapshot timestamptz,
  p_updated_since timestamptz,
  p_limit int
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
  -- Keep this in step with the client's 1 MB page target. A page may exceed it
  -- by the size of its first row; it never silently omits that row.
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
  v_pass public.projection_sync_passes%rowtype;
  v_has_pass boolean := false;
  v_replay boolean := false;
  v_language_count int;
  -- A real account enrolls a handful of languages. This well-above-real cap
  -- keeps a charged snapshot from becoming an unbounded namespace for
  -- invented (but structurally valid) language rows.
  v_max_languages constant int := 50;
  v_today timestamptz := date_trunc('day', clock_timestamp() at time zone 'utc')
    at time zone 'utc';
begin
  if v_user_id is null then
    -- Preserve the read endpoint's contract: no subject means no rows, not an
    -- error and not a shared quota bucket.
    return jsonb_build_object('rows', '[]'::jsonb, 'hasMore', false, 'nextCursor', null);
  end if;
  if p_language_code is null or p_language_code = '' then
    return jsonb_build_object('rows', '[]'::jsonb, 'hasMore', false, 'nextCursor', null);
  end if;
  -- Same shape as the user_languages check. The projection is per-language;
  -- an arbitrary long language string would only create pass-state rows.
  if p_language_code !~ '^[a-z]{2}(-[A-Za-z]{2})?$' then
    raise exception 'invalid projection language code'
      using errcode = 'PT400';
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
              v_today + interval '1 day' - clock_timestamp()
            )))::int
          );
          raise exception 'projection complete-sync quota exceeded'
            using errcode = 'PT429',
                  detail = 'bucket=sync;retry_after_seconds=' || v_retry_seconds::text,
                  hint = 'The daily complete-projection limit resets at 00:00 UTC.';
        end if;
      end if;

      if p_after_lemma is null then
        -- A same-snapshot restart after an interrupted first projection. The
        -- client persisted the snapshot before its first page but never stored
        -- a cursor, so it must be allowed to re-read from lemma 0. This is
        -- idempotent and does not charge another daily unit (the snapshot is
        -- already the pass key); reset the stored cursor so the following pages
        -- validate against the new sequence.
        update public.projection_sync_passes
        set last_cursor = null,
            previous_cursor = null
        where user_id = v_user_id
          and snapshot = p_snapshot
          and language_code = p_language_code;
      elsif p_after_lemma is distinct from v_pass.last_cursor
         and p_after_lemma is distinct from v_pass.previous_cursor then
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

      -- A charged snapshot may span its enrolled languages, but it must not be
      -- a namespace for unlimited pass rows. This also bounds a caller that
      -- invents valid-looking but unenrolled languages.
      select count(*) into v_language_count
      from public.projection_sync_passes
      where user_id = v_user_id and snapshot = p_snapshot;
      if v_language_count >= v_max_languages then
        raise exception 'too many languages for one projection pass'
          using errcode = 'PT400';
      end if;

      if not public.consume_projection_sync(p_snapshot, p_language_code) then
        v_retry_seconds := greatest(
          1,
          ceil(extract(epoch from (
            v_today + interval '1 day' - clock_timestamp()
          )))::int
        );
        raise exception 'projection complete-sync quota exceeded'
          using errcode = 'PT429',
                detail = 'bucket=sync;retry_after_seconds=' || v_retry_seconds::text,
                hint = 'The daily complete-projection limit resets at 00:00 UTC.';
      end if;
    end if;
  end if;

  -- One extra row beyond the row limit is never requested, so the candidate
  -- array is enough to decide the row-limit side of `hasMore`. The byte side is
  -- decided by comparing the picked page to the candidates.
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
      and (
        p_snapshot is null
        or (e.server_updated_at <= p_snapshot and e.deleted_at is null)
      )
      and (p_updated_since is null or e.server_updated_at > p_updated_since)
    order by e.language_code, e.lemma
    limit v_limit
  ) as c;

  v_candidate_count := coalesce(array_length(v_candidates, 1), 0);

  if v_candidate_count > 0 then
    foreach v_row in array v_candidates loop
      v_row_bytes := octet_length(row_to_json(v_row)::text);
      -- Always include the first row, even when it alone exceeds the budget:
      -- a page must make progress and must not drop a lemma.
      exit when v_count > 0 and v_page_bytes + v_row_bytes > v_byte_budget;
      v_page := array_append(v_page, v_row);
      v_page_bytes := v_page_bytes + v_row_bytes;
      v_count := v_count + 1;
      v_last_lemma := v_row.lemma;
    end loop;
  end if;

  if v_count < v_candidate_count then
    -- Byte truncation: the language continues after this short page.
    v_has_more := true;
  elsif v_candidate_count = v_limit then
    -- The row limit filled exactly; check whether another row exists so a
    -- short final page is still reported as the end.
    select exists (
      select 1
      from public.wordbook_entries e
      where e.user_id = v_user_id
        and e.language_code = p_language_code
        and e.lemma > v_last_lemma
        and (
          p_snapshot is null
          or (e.server_updated_at <= p_snapshot and e.deleted_at is null)
        )
        and (p_updated_since is null or e.server_updated_at > p_updated_since)
    )
    into v_has_more;
  end if;

  if p_snapshot is not null and not v_replay then
    if not v_has_more then
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
      update public.projection_sync_passes
      set last_cursor = v_last_lemma,
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

  return jsonb_build_object(
    'rows', coalesce(to_jsonb(v_page), '[]'::jsonb),
    'hasMore', v_has_more,
    'nextCursor', case when v_count > 0 then v_last_lemma else p_after_lemma end
  );
end;
$$;

comment on function public.get_wordbook_projection_page_bounded(text, text, timestamptz, timestamptz, int) is
  'One byte- and row-bounded wordbook projection page as { rows, hasMore, nextCursor }. SECURITY DEFINER with an explicit auth.uid() filter; charges the page quota, enforces server-side pass state, and charges at most 2 complete syncs per UTC day. hasMore is authoritative even when the page is short because of the ~1 MiB byte cap.';

revoke all on function public.get_wordbook_projection_page_bounded(text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.get_wordbook_projection_page_bounded(text, text, timestamptz, timestamptz, int)
  to authenticated;

-- Keep the original row-set signature for callers that only need rows, but
-- route it through the bounded implementation so no authenticated read can
-- bypass the byte cap.
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
  v_page jsonb;
begin
  v_page := public.get_wordbook_projection_page_bounded(
    p_language_code,
    p_after_lemma,
    p_snapshot,
    p_updated_since,
    p_limit
  );
  return query
    select r.*
    from jsonb_populate_recordset(
      null::public.wordbook_entries,
      coalesce(v_page->'rows', '[]'::jsonb)
    ) as r;
end;
$$;

comment on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int) is
  'Row-set wrapper over get_wordbook_projection_page_bounded. Preserved for existing clients and SQL tests; every read is still byte-bounded.';

revoke all on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  to authenticated;
