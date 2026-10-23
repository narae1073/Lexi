-- Make replace_word_occurrences idempotent and diff based.
--
-- The R2 RPC deleted every occurrence row for a document and inserted the whole
-- payload again on every push. A device that re-pushed an unchanged document
-- therefore rewrote every row and advanced documents.server_updated_at, which
-- made every other device pull the document again. With a wordbook projection
-- on top, that churn would rebuild the same entries over and over.
--
-- This migration stores a canonical hash of the document's occurrence set. An
-- identical payload — same rows, any order — returns before touching
-- word_occurrences or documents. A changed payload deletes only rows that are
-- gone and updates only rows whose values changed.
--
-- The hash is computed from the same canonical JSON the write path uses, so the
-- hash and the stored rows cannot disagree about what "the same set" means.

alter table public.documents
  add column occurrences_hash text;

comment on column public.documents.occurrences_hash is
  'Canonical SHA-256 of the document occurrence set. NULL until the first replace_word_occurrences call.';

-- ---------------------------------------------------------------------------
-- Canonical occurrence rows
--
-- One row per (lemma, surface), which is the word_occurrences_unique key. The
-- unique key does not include language_code, so a duplicate key with different
-- values must resolve deterministically: keep the earliest character position.
-- Every field that the write path stores is part of the canonical form; leaving
-- one out would make a real edit hash the same and be skipped as a no-op.
--
-- Text ordering uses collate "C" so the hash does not depend on the database
-- collation. The function is immutable and has an empty search_path so its
-- result cannot change with a caller's schemas.
-- ---------------------------------------------------------------------------

create or replace function public.word_occurrence_canonical(p_rows jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      canonical_row
      order by
        canonical_row->>'language_code' collate "C",
        canonical_row->>'lemma' collate "C",
        canonical_row->>'surface' collate "C",
        (canonical_row->>'char_start')::int,
        (canonical_row->>'char_end')::int,
        canonical_row->>'sentence' collate "C",
        (canonical_row->>'occurrences_count')::int
    ),
    '[]'::jsonb
  )
  from (
    select distinct on (
      entry->>'lemma' collate "C",
      entry->>'surface' collate "C"
    )
      jsonb_build_object(
        'language_code', entry->>'language_code',
        'lemma', entry->>'lemma',
        'surface', entry->>'surface',
        'char_start', (entry->>'char_start')::int,
        'char_end', (entry->>'char_end')::int,
        'sentence', entry->>'sentence',
        'occurrences_count', coalesce((entry->>'occurrences_count')::int, 1)
      ) as canonical_row
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as entry
    order by
      entry->>'lemma' collate "C",
      entry->>'surface' collate "C",
      (entry->>'char_start')::int,
      (entry->>'char_end')::int,
      entry->>'sentence' collate "C",
      entry->>'language_code' collate "C",
      coalesce((entry->>'occurrences_count')::int, 1)
  ) canonical;
$$;

create or replace function public.word_occurrence_hash(p_rows jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(public.word_occurrence_canonical(p_rows)::text, 'sha256'),
    'hex'
  );
$$;

comment on function public.word_occurrence_hash(jsonb) is
  'Canonical SHA-256 of an occurrence payload; independent of row order and of numeric-vs-string JSON values.';

revoke all on function public.word_occurrence_canonical(jsonb) from public, anon;
revoke all on function public.word_occurrence_hash(jsonb) from public, anon;
grant execute on function public.word_occurrence_canonical(jsonb) to authenticated;
grant execute on function public.word_occurrence_hash(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- replace_word_occurrences
--
-- Signature and security invoker stay the same, so existing clients keep
-- working and RLS still applies. The ownership check doubles as the hash read:
-- a document the caller cannot see is reported as not found, exactly as before.
--
-- The document row is locked before the hash is read. Without that lock, two
-- concurrent pushes of different payloads can interleave: the loser's rows are
-- inserted after the winner's delete snapshot, then the loser blocks on the
-- winner's documents update. The result is a superset of rows with one payload's
-- hash stored, and a later push of that payload short-circuits on the matching
-- hash and never repairs the extra rows. Locking serializes same-document
-- replacement; the waiting transaction re-reads the committed hash under READ
-- COMMITTED and diffs against the actual committed row set.
-- ---------------------------------------------------------------------------

create or replace function public.replace_word_occurrences(
  p_document_id uuid,
  p_rows jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing_hash text;
  v_incoming_hash text;
  v_rows jsonb;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- Lock before reading the hash or touching occurrences. The same row lock
  -- also covers the documents hash update at the end of this function.
  select d.occurrences_hash
  into v_existing_hash
  from public.documents d
  where d.id = p_document_id
    and d.user_id = v_user_id
  for update;

  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;

  v_incoming_hash := public.word_occurrence_hash(p_rows);

  -- Same set, any row order: leave word_occurrences and documents untouched.
  if v_existing_hash is not distinct from v_incoming_hash then
    return;
  end if;

  v_rows := public.word_occurrence_canonical(p_rows);

  -- Only rows that are gone from the incoming set. A changed row stays and is
  -- updated by the upsert below, so its identity and id are preserved.
  delete from public.word_occurrences o
  where o.user_id = v_user_id
    and o.document_id = p_document_id
    and not exists (
      select 1
      from jsonb_array_elements(v_rows) as entry
      where entry->>'lemma' = o.lemma
        and entry->>'surface' = o.surface
    );

  insert into public.word_occurrences (
    user_id, document_id, language_code, lemma, surface,
    char_start, char_end, sentence, occurrences_count
  )
  select
    v_user_id,
    p_document_id,
    entry->>'language_code',
    entry->>'lemma',
    entry->>'surface',
    (entry->>'char_start')::int,
    (entry->>'char_end')::int,
    entry->>'sentence',
    (entry->>'occurrences_count')::int
  from jsonb_array_elements(v_rows) as entry
  on conflict (user_id, document_id, lemma, surface) do update
  set language_code = excluded.language_code,
      char_start = excluded.char_start,
      char_end = excluded.char_end,
      sentence = excluded.sentence,
      occurrences_count = excluded.occurrences_count
  where (
    public.word_occurrences.language_code,
    public.word_occurrences.char_start,
    public.word_occurrences.char_end,
    public.word_occurrences.sentence,
    public.word_occurrences.occurrences_count
  ) is distinct from (
    excluded.language_code,
    excluded.char_start,
    excluded.char_end,
    excluded.sentence,
    excluded.occurrences_count
  );

  -- A real change owns a new hash. server_updated_at is left to the existing
  -- set_server_updated_at trigger; updated_at is left alone because this is not
  -- a content edit.
  update public.documents
  set occurrences_hash = v_incoming_hash
  where user_id = v_user_id
    and id = p_document_id;
end;
$$;

revoke all on function public.replace_word_occurrences(uuid, jsonb) from public;
grant execute on function public.replace_word_occurrences(uuid, jsonb) to authenticated;
