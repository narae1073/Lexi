-- Bounded incremental projection pages and a no-op touch (R3, task 6 review).
--
-- This migration supersedes two functions from 20261027000003 without editing
-- that applied migration:
--
--   1. get_wordbook_projection_page gains `p_updated_since`. A full page is
--      still bounded by `p_snapshot` and excludes soft-deleted rows; an
--      incremental page is now bounded by `server_updated_at > p_updated_since`
--      and includes soft-deleted rows, so it can propagate deletions and
--      revivals without scanning the whole language.
--   2. touch_document becomes a real no-op when the supplied open is not newer.
--      It must not write, and therefore must not advance server_updated_at,
--      when the client's timestamp would not move last_opened_at.
--
-- The four-argument page function is dropped: it cannot express a bounded
-- incremental page, and every caller in this repository is updated to the
-- five-argument form. (No R3 client was deployed, so there is no client to
-- keep it for.)

drop function if exists public.get_wordbook_projection_page(text, text, timestamptz, int);

-- ---------------------------------------------------------------------------
-- get_wordbook_projection_page (snapshot full page / watermark incremental page)
--
-- Exactly one mode per call:
--   * p_snapshot set     -> full page: server_updated_at <= p_snapshot and
--                            deleted_at is null;
--   * p_updated_since set -> incremental page: server_updated_at >
--                            p_updated_since, including soft-deleted rows;
--   * both null          -> unbounded enumeration (all rows for the language,
--                            including soft deletions). Kept for a manual
--                            rebuild; normal sync must pass a watermark.
--   * both set           -> error 22023. Mixing the bounds would silently
--                            change which rows a client applies.
--
-- Paging is still by the `(language_code, lemma)` keyset with a 1000-row
-- ceiling. The caller resumes with `p_after_lemma`; the bound (snapshot or
-- watermark) stays fixed across the pages of one pass.
--
-- A bounded incremental pass cannot skip a row: it applies every row whose
-- watermark is above the stored one, in either direction of the lemma order.
-- A soft delete is such a row; a revival is such a row.
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
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_snapshot is not null and p_updated_since is not null then
    raise exception 'pass p_snapshot for a full page or p_updated_since for an incremental page, not both'
      using errcode = '22023';
  end if;

  return query
  select e.*
  from public.wordbook_entries e
  where e.user_id = auth.uid()
    and e.language_code = p_language_code
    and (p_after_lemma is null or e.lemma > p_after_lemma)
    and (
      p_snapshot is null
      or (e.server_updated_at <= p_snapshot and e.deleted_at is null)
    )
    and (p_updated_since is null or e.server_updated_at > p_updated_since)
  order by e.language_code, e.lemma
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
end;
$$;

comment on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int) is
  'One resumable wordbook projection page for the caller. p_snapshot: full page, snapshot-bounded, live rows only. p_updated_since: incremental page, watermark-bounded, soft deletions included. Exactly one bound per call.';

revoke all on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.get_wordbook_projection_page(text, text, timestamptz, timestamptz, int)
  to authenticated;

-- ---------------------------------------------------------------------------
-- touch_document: skip a non-newer open without writing
--
-- `FOUND` after a skipped UPDATE is false for two different reasons, so the
-- function checks existence afterwards: a missing/foreign document still
-- raises P0002, while an open that would not move last_opened_at is a
-- successful no-op.
--
-- Because the skipped path runs no UPDATE, the documents BEFORE UPDATE
-- triggers do not fire and server_updated_at does not advance. Other devices
-- therefore do not re-download a document just because this device reported
-- an older or identical open.
-- ---------------------------------------------------------------------------

create or replace function public.touch_document(
  p_document_id uuid,
  p_opened_at timestamptz
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_opened_at timestamptz := coalesce(p_opened_at, clock_timestamp());
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  update public.documents d
  set last_opened_at = v_opened_at
  where d.id = p_document_id
    and d.user_id = v_user_id
    and v_opened_at > coalesce(d.last_opened_at, '-infinity'::timestamptz);

  if found then
    return;
  end if;

  perform 1
  from public.documents d
  where d.id = p_document_id
    and d.user_id = v_user_id;

  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.touch_document(uuid, timestamptz) is
  'Records that the caller opened a document by updating only last_opened_at, and only when the open is newer.';
