-- Paged document content (R3, task 9).
--
-- `get_document_payload` returns one document's text, versions, and every
-- occurrence row in a single response. A very large document would make that a
-- multi-megabyte body, so the client stops using it above its 10 MB soft cap and
-- reads the text through this endpoint instead.
--
-- Contract:
--   * page by character offset: `p_after_char` is the number of characters
--     already read (0 on the first page);
--   * at most `p_max_chars` characters per page (NULL means 262,144, larger
--     values are clamped to 1,000,000 — roughly 4 MB in the worst UTF-8 case);
--   * `contentUpdatedAt` is repeated on every page so the reader can detect a
--     text edit that landed mid-read and restart instead of joining two texts;
--   * `nextOffset` is where the next page starts and `done` says whether this
--     page reached the end. An offset past the end returns an empty page with
--     `done = true`, so a retry can resume without a special case;
--   * NULL for a document the caller does not own or that no longer exists —
--     the same rule as `get_document_payload`.
--
-- RLS remains the tenant boundary; `auth.uid()` is also part of the query so a
-- missing policy can never turn this into a cross-account read.

create or replace function public.get_document_content_page(
  p_document_id uuid,
  p_after_char int,
  p_max_chars int
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'rawText', chunk.page_text,
    'contentUpdatedAt', d.content_updated_at,
    'charCount', char_length(d.raw_text),
    'nextOffset', least(chunk.start_at + char_length(chunk.page_text), char_length(d.raw_text)),
    'done', chunk.start_at + char_length(chunk.page_text) >= char_length(d.raw_text)
  )
  from public.documents d
  cross join lateral (
    select
      greatest(coalesce(p_after_char, 0), 0) as start_at,
      substr(
        d.raw_text,
        greatest(coalesce(p_after_char, 0), 0) + 1,
        least(greatest(coalesce(p_max_chars, 262144), 1), 1000000)
      ) as page_text
  ) chunk
  where d.id = p_document_id
    and d.user_id = auth.uid();
$$;

comment on function public.get_document_content_page(uuid, int, int) is
  'One resumable page of a document''s raw text with its content version; NULL for any document the caller does not own.';

revoke all on function public.get_document_content_page(uuid, int, int)
  from public, anon, authenticated;
grant execute on function public.get_document_content_page(uuid, int, int)
  to authenticated;
