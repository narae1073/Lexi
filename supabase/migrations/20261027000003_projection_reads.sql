-- Projection read path and lazy document payload (R3, task 6).
--
-- Three authenticated, security-invoker read endpoints. RLS remains the tenant
-- boundary; every query is also filtered by auth.uid() so a missing policy can
-- never turn a read into a cross-account one.
--
--   1. get_wordbook_projection_page — one resumable page of a language's
--      wordbook projection.
--   2. get_document_payload — raw text, content/occurrence versions, and the
--      document's occurrence rows, fetched only when a document is opened.
--   3. touch_document — records an open without pretending it edited content.
--
-- The full projection uses its own snapshot, taken once with sync_snapshot()
-- and persisted with the page cursor. It is deliberately independent of the
-- R2 document/occurrence pull watermark: projection pages must never advance
-- that watermark.

-- ---------------------------------------------------------------------------
-- get_wordbook_projection_page
--
-- Paging contract:
--   * page by (language_code, lemma) keyset: `lemma > p_after_lemma`;
--   * at most 1000 rows (p_limit NULL means 1000, larger values are clamped);
--   * p_snapshot set  -> full projection page: rows with
--     server_updated_at <= p_snapshot and deleted_at is null;
--   * p_snapshot null -> incremental page: no upper bound and soft-deleted
--     rows included, so a client can remove local phantoms.
--
-- Why this cannot skip a row:
--   A row outside a full page is outside it for exactly one of two reasons.
--   Either it was already soft-deleted at the snapshot (the client must not
--   have it), or it changed after the snapshot (server_updated_at > snapshot,
--   including a delete/revive whose lemma sorts before the cursor). The second
--   group is picked up by the incremental wordbook pull that starts at this
--   same snapshot with the normal overlap. A row that becomes visible late
--   with server_updated_at <= snapshot (a transaction that started before the
--   snapshot) is inside the overlap window, exactly as the R2 pull relies on.
--   No row is ever excluded because the cursor has already passed it while it
--   still satisfied the snapshot.
--
-- Purge recovery:
--   The normal document-delete path drains its lemmas synchronously (Task 4),
--   so a page read does not drain anything. Draining here would turn every
--   read into a write transaction and take the per-user refresh advisory lock
--   on the hot projection path. `drain_wordbook_refresh_queue(auth.uid())`
--   remains the explicit server-side recovery entry point if a bulk path ever
--   leaves work queued; it is not granted to clients.
-- ---------------------------------------------------------------------------

create or replace function public.get_wordbook_projection_page(
  p_language_code text,
  p_after_lemma text,
  p_snapshot timestamptz,
  p_limit int
)
returns setof public.wordbook_entries
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select e.*
  from public.wordbook_entries e
  where e.user_id = auth.uid()
    and e.language_code = p_language_code
    and (p_after_lemma is null or e.lemma > p_after_lemma)
    and (p_snapshot is null or e.server_updated_at <= p_snapshot)
    and (p_snapshot is null or e.deleted_at is null)
  order by e.language_code, e.lemma
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

comment on function public.get_wordbook_projection_page(text, text, timestamptz, int) is
  'One resumable wordbook projection page for the caller. Full pages (p_snapshot set) are bounded by the snapshot and exclude soft-deleted rows; incremental pages (p_snapshot null) include them.';

revoke all on function public.get_wordbook_projection_page(text, text, timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.get_wordbook_projection_page(text, text, timestamptz, int)
  to authenticated;

-- ---------------------------------------------------------------------------
-- get_document_payload
--
-- Returns NULL for a document the caller does not own (or that no longer
-- exists), and never leaks another tenant's text or occurrences.
--
-- The payload carries the versions the client compares before refetching:
-- `contentUpdatedAt` changes only on a raw_text/language edit, while
-- `occurrencesUpdatedAt` changes when occurrence rows change. Opening a
-- document is `touch_document`, so it changes neither.
--
-- Occurrence rows are ordered by position so the client can rebuild the same
-- (document, lemma) groups it would have computed locally.
-- ---------------------------------------------------------------------------

create or replace function public.get_document_payload(p_document_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'rawText', d.raw_text,
    'contentUpdatedAt', d.content_updated_at,
    'occurrencesUpdatedAt', d.occurrences_updated_at,
    'occurrences', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'languageCode', o.language_code,
                   'lemma', o.lemma,
                   'surface', o.surface,
                   'charStart', o.char_start,
                   'charEnd', o.char_end,
                   'sentence', o.sentence,
                   'occurrencesCount', o.occurrences_count
                 )
                 order by o.char_start, o.char_end, o.lemma, o.surface
               )
        from public.word_occurrences o
        where o.user_id = d.user_id
          and o.document_id = d.id
      ),
      '[]'::jsonb
    )
  )
  from public.documents d
  where d.id = p_document_id
    and d.user_id = auth.uid();
$$;

comment on function public.get_document_payload(uuid) is
  'Raw text, content/occurrence versions, and occurrence rows for one of the caller''s documents; NULL for any other document.';

revoke all on function public.get_document_payload(uuid) from public, anon, authenticated;
grant execute on function public.get_document_payload(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- touch_document
--
-- Opening a document records only last_opened_at. It must not touch raw_text,
-- content_updated_at, occurrences_updated_at, title, folder, or trash state;
-- the documents triggers already keep content_updated_at tied to a real text
-- edit, and metadata syncing learns about the open through server_updated_at.
--
-- last_opened_at never moves backwards: a device with a slow clock cannot undo
-- a later open. A document that is gone (or belongs to someone else) raises
-- P0002 instead of pretending to have recorded the open.
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
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  update public.documents d
  set last_opened_at = greatest(
        coalesce(d.last_opened_at, '-infinity'::timestamptz),
        coalesce(p_opened_at, clock_timestamp())
      )
  where d.id = p_document_id
    and d.user_id = v_user_id;

  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.touch_document(uuid, timestamptz) is
  'Records that the caller opened a document by updating only last_opened_at.';

revoke all on function public.touch_document(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.touch_document(uuid, timestamptz) to authenticated;
