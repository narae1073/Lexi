-- Set-based refresh of the wordbook projection (R3, task 4).
--
-- Task 3 created `wordbook_entries` and backfilled it. This migration adds the
-- only write paths that keep it current afterwards:
--
--   * `refresh_wordbook_pairs`: one set-based statement for a batch of
--     (user, language, lemma) pairs. Every refresh path funnels through it.
--   * `replace_word_occurrences`: recomputes the union of the old and new
--     lemmas exactly once after a real diff (and not at all on a hash no-op).
--   * a statement-level `word_states` trigger that fires once per statement
--     and refreshes each distinct affected lemma (never one trigger per row).
--   * a queued document purge: a row trigger records the deleted document's
--     lemmas before the cascade removes them, and a statement trigger drains
--     the queue after the delete in one set-based pass. This covers the R2
--     clients that delete documents directly as well as `delete_document`.
--
-- Ordering:
--
-- Every projection write for a batch runs `order by user_id, language_code,
-- lemma`. Two concurrent pushes that touch the same lemmas therefore request
-- the row locks in the same order, which is what keeps a shared-lemma update
-- from deadlocking.
--
-- Security:
--
-- Refresh functions are internal. They are security definer with a fixed
-- search_path and are not executable by clients. The RPCs and trigger
-- functions that need them are security definer too, and every statement they
-- run is filtered by `auth.uid()` or by the OLD row of a trigger.

-- ---------------------------------------------------------------------------
-- One set-based refresh statement
--
-- `p_pairs` is a JSON array of {userId, languageCode, lemma}. A JSON batch
-- keeps all callers (RPC, trigger, purge drain) on one function while still
-- passing a set. The recompute statement:
--
--   1. recomputes counts/surfaces/contexts exactly like the Task 3 backfill;
--   2. inserts live entries or updates existing ones;
--   3. soft-deletes a live entry whose last occurrence disappeared.
--
-- A lemma with no occurrence and no existing live entry is not inserted, so a
-- word with a state but no occurrence never leaks into the projection.
-- Already-soft-deleted rows are left untouched: a repeated refresh of a dead
-- lemma must not advance its watermark again.
--
-- The ON CONFLICT WHERE clause skips an update whose recomputed row is equal
-- to the stored one. This is what makes a word-state trigger that changed
-- nothing projected (or a purge that drains an unchanged lemma) a true no-op
-- instead of watermark churn.
--
-- Refreshes for one user are serialized with a transaction-scoped advisory
-- lock taken before the recompute. Without it, two concurrent pushes that
-- share a lemma can each read a snapshot that does not contain the other's
-- uncommitted occurrence rows; the second one then waits on the projection row
-- lock and writes counts computed from the stale snapshot. The lock is taken
-- in a statement before the recompute, so the recompute's snapshot is fresh
-- (READ COMMITTED) and includes the winner's committed rows. It also removes
-- any lock cycle across the (language_code, lemma) order.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_wordbook_pairs(p_pairs jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(u.user_id::text, 0))
  from (
    select distinct (pair->>'userId')::uuid as user_id
    from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) as pair
    where jsonb_typeof(pair) = 'object'
      and pair ? 'userId'
  ) u
  order by u.user_id;

  with requested as (
    select distinct
      (pair->>'userId')::uuid as user_id,
      pair->>'languageCode' as language_code,
      pair->>'lemma' as lemma
    from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) as pair
    where jsonb_typeof(pair) = 'object'
      and pair ? 'userId'
      and pair ? 'languageCode'
      and pair ? 'lemma'
  ),
  per_document as (
    select
      o.user_id,
      o.language_code,
      o.lemma,
      o.document_id,
      -- Every surface row of one (document, lemma) carries the same count.
      -- max() picks that value once without depending on row order.
      max(o.occurrences_count)::int as occurrences_count
    from public.word_occurrences o
    join requested r
      on r.user_id = o.user_id
     and r.language_code = o.language_code
     and r.lemma = o.lemma
    group by o.user_id, o.language_code, o.lemma, o.document_id
  ),
  totals as (
    select
      p.user_id,
      p.language_code,
      p.lemma,
      count(*)::int as document_count,
      sum(p.occurrences_count)::int as occurrence_count
    from per_document p
    group by p.user_id, p.language_code, p.lemma
  ),
  surfaces as (
    select
      o.user_id,
      o.language_code,
      o.lemma,
      array_agg(distinct o.surface order by o.surface) as surfaces
    from public.word_occurrences o
    join requested r
      on r.user_id = o.user_id
     and r.language_code = o.language_code
     and r.lemma = o.lemma
    group by o.user_id, o.language_code, o.lemma
  ),
  contexts as (
    select
      c.user_id,
      c.language_code,
      c.lemma,
      jsonb_agg(
        jsonb_build_object('documentId', c.document_id, 'sentence', c.sentence)
        order by c.document_id, c.sentence
      ) as contexts
    from (
      select distinct
        o.user_id,
        o.language_code,
        o.lemma,
        o.document_id,
        o.sentence
      from public.word_occurrences o
      join requested r
        on r.user_id = o.user_id
       and r.language_code = o.language_code
       and r.lemma = o.lemma
      where btrim(o.sentence) <> ''
    ) c
    group by c.user_id, c.language_code, c.lemma
  ),
  recomputed as (
    select
      r.user_id,
      r.language_code,
      r.lemma,
      coalesce(t.occurrence_count, 0) as occurrence_count,
      coalesce(t.document_count, 0) as document_count,
      coalesce(s.surfaces, '{}'::text[]) as surfaces,
      coalesce(c.contexts, '[]'::jsonb) as contexts,
      ws.status,
      coalesce(ws.is_favorite, false) as is_favorite,
      coalesce(ws.star_angle::int, 0) as star_angle,
      coalesce(ws.star_color, '#eab308') as star_color,
      coalesce(ws.seen_count, 1) as seen_count,
      ws.first_seen_at,
      ws.last_seen_at,
      ws.favorite_updated_at,
      coalesce(ws.known_presses, 0) as known_presses,
      coalesce(ws.unsure_presses, 0) as unsure_presses,
      coalesce(ws.unknown_presses, 0) as unknown_presses,
      ws.note,
      ws.note_updated_at
    from requested r
    left join totals t
      on t.user_id = r.user_id
     and t.language_code = r.language_code
     and t.lemma = r.lemma
    left join surfaces s
      on s.user_id = r.user_id
     and s.language_code = r.language_code
     and s.lemma = r.lemma
    left join contexts c
      on c.user_id = r.user_id
     and c.language_code = r.language_code
     and c.lemma = r.lemma
    left join public.word_states ws
      on ws.user_id = r.user_id
     and ws.language_code = r.language_code
     and ws.lemma = r.lemma
  )
  insert into public.wordbook_entries as e (
    user_id, language_code, lemma,
    surfaces, contexts, occurrence_count, document_count,
    status, is_favorite, star_angle, star_color,
    seen_count, first_seen_at, last_seen_at, favorite_updated_at,
    known_presses, unsure_presses, unknown_presses,
    note, note_updated_at,
    deleted_at
  )
  select
    r.user_id,
    r.language_code,
    r.lemma,
    r.surfaces,
    r.contexts,
    r.occurrence_count,
    r.document_count,
    r.status,
    r.is_favorite,
    r.star_angle,
    r.star_color,
    r.seen_count,
    r.first_seen_at,
    r.last_seen_at,
    r.favorite_updated_at,
    r.known_presses,
    r.unsure_presses,
    r.unknown_presses,
    r.note,
    r.note_updated_at,
    -- A dead lemma keeps an empty derived payload. dead_at must be a fresh
    -- timestamp; an already-deleted row is excluded below and never rewritten.
    case when r.occurrence_count = 0 then clock_timestamp() else null end
  from recomputed r
  where r.occurrence_count > 0
     or exists (
       select 1
       from public.wordbook_entries live
       where live.user_id = r.user_id
         and live.language_code = r.language_code
         and live.lemma = r.lemma
         and live.deleted_at is null
     )
  order by r.user_id, r.language_code, r.lemma
  on conflict (user_id, language_code, lemma) do update
  set surfaces = excluded.surfaces,
      contexts = excluded.contexts,
      occurrence_count = excluded.occurrence_count,
      document_count = excluded.document_count,
      status = excluded.status,
      is_favorite = excluded.is_favorite,
      star_angle = excluded.star_angle,
      star_color = excluded.star_color,
      seen_count = excluded.seen_count,
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at,
      favorite_updated_at = excluded.favorite_updated_at,
      known_presses = excluded.known_presses,
      unsure_presses = excluded.unsure_presses,
      unknown_presses = excluded.unknown_presses,
      note = excluded.note,
      note_updated_at = excluded.note_updated_at,
      -- Reappeared: revive. Last occurrence gone: soft-delete.
      deleted_at = excluded.deleted_at
  where (
    e.surfaces,
    e.contexts,
    e.occurrence_count,
    e.document_count,
    e.status,
    e.is_favorite,
    e.star_angle,
    e.star_color,
    e.seen_count,
    e.first_seen_at,
    e.last_seen_at,
    e.favorite_updated_at,
    e.known_presses,
    e.unsure_presses,
    e.unknown_presses,
    e.note,
    e.note_updated_at,
    e.deleted_at is null
  ) is distinct from (
    excluded.surfaces,
    excluded.contexts,
    excluded.occurrence_count,
    excluded.document_count,
    excluded.status,
    excluded.is_favorite,
    excluded.star_angle,
    excluded.star_color,
    excluded.seen_count,
    excluded.first_seen_at,
    excluded.last_seen_at,
    excluded.favorite_updated_at,
    excluded.known_presses,
    excluded.unsure_presses,
    excluded.unknown_presses,
    excluded.note,
    excluded.note_updated_at,
    excluded.deleted_at is null
  );
end;
$$;

comment on function public.refresh_wordbook_pairs(jsonb) is
  'Internal set-based refresh. Recomputes one or more (user, language, lemma) projection entries from source in a single set-based statement.';

revoke all on function public.refresh_wordbook_pairs(jsonb)
  from public, anon, authenticated;

-- Server-internal entry points required by the R3 plan. They are thin wrappers
-- so callers reason in one language/lemma at a time; they still end in one
-- set-based statement.

create or replace function public.refresh_wordbook_entries(
  p_user_id uuid,
  p_language_code text,
  p_lemmas text[]
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.refresh_wordbook_pairs(
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'userId', p_user_id,
                   'languageCode', p_language_code,
                   'lemma', l.lemma
                 )
                 order by l.lemma
               )
        from (
          select distinct lemma
          from unnest(p_lemmas) as t(lemma)
          where t.lemma is not null
        ) l
        where p_language_code is not null
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function public.refresh_wordbook_entries(uuid, text, text[]) is
  'Internal set-based refresh for one user/language and a lemma array.';

revoke all on function public.refresh_wordbook_entries(uuid, text, text[])
  from public, anon, authenticated;

create or replace function public.refresh_wordbook_entry(
  p_user_id uuid,
  p_language_code text,
  p_lemma text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.refresh_wordbook_entries(
    p_user_id,
    p_language_code,
    array[p_lemma]
  );
$$;

comment on function public.refresh_wordbook_entry(uuid, text, text) is
  'Internal single-entry wrapper around refresh_wordbook_entries.';

revoke all on function public.refresh_wordbook_entry(uuid, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- word_states: statement-level refresh
--
-- A statement-level trigger sees the whole affected set through transition
-- tables, so a multi-row statement fires one trigger invocation, not one per
-- row. It refreshes each distinct affected lemma through the single-entry
-- refresh and never any other lemma. The three triggers exist because
-- PostgreSQL does not allow transition tables on a trigger with more than one
-- event.
--
-- The refresh only touches entries that already exist. A word state without an
-- occurrence is not part of the wordbook projection and is not inserted here.
-- A cascade from `auth.users` (trigger depth > 1) is ignored: those projection
-- rows are deleted with the user in the same statement.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_wordbook_entries_from_states()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_affected record;
begin
  if pg_trigger_depth() > 1 then
    -- Cascade from auth.users: the projection rows are being deleted with the
    -- user. Refreshing here would race the wordbook_entries cascade and could
    -- re-insert a row whose owner is already gone.
    return null;
  end if;

  if tg_op = 'INSERT' then
    for v_affected in
      select distinct user_id, language_code, lemma
      from new_rows
      order by user_id, language_code, lemma
    loop
      perform public.refresh_wordbook_entry(
        v_affected.user_id,
        v_affected.language_code,
        v_affected.lemma
      );
    end loop;
  elsif tg_op = 'DELETE' then
    for v_affected in
      select distinct user_id, language_code, lemma
      from old_rows
      order by user_id, language_code, lemma
    loop
      perform public.refresh_wordbook_entry(
        v_affected.user_id,
        v_affected.language_code,
        v_affected.lemma
      );
    end loop;
  else
    -- A lemma rename affects both the old and the new entry.
    for v_affected in
      select user_id, language_code, lemma
      from (
        select user_id, language_code, lemma from new_rows
        union
        select user_id, language_code, lemma from old_rows
      ) u
      order by user_id, language_code, lemma
    loop
      perform public.refresh_wordbook_entry(
        v_affected.user_id,
        v_affected.language_code,
        v_affected.lemma
      );
    end loop;
  end if;

  return null;
end;
$$;

revoke all on function public.refresh_wordbook_entries_from_states()
  from public, anon, authenticated;

create trigger word_states_refresh_insert
  after insert on public.word_states
  referencing new table as new_rows
  for each statement execute function public.refresh_wordbook_entries_from_states();

create trigger word_states_refresh_update
  after update on public.word_states
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.refresh_wordbook_entries_from_states();

create trigger word_states_refresh_delete
  after delete on public.word_states
  referencing old table as old_rows
  for each statement execute function public.refresh_wordbook_entries_from_states();

-- ---------------------------------------------------------------------------
-- Document purge
--
-- A document delete cascades to word_occurrences. The lemmas must be captured
-- before the cascade, but PostgreSQL only allows transition tables on AFTER
-- triggers, where the occurrences are already gone. A BEFORE ROW trigger is
-- therefore the capture point; it writes only to the queue, never refreshes.
--
-- A statement-level AFTER trigger then drains the queue for the affected users
-- in one set-based refresh per user. That keeps an R2 client's direct delete
-- (and PostgREST bulk delete) immediately consistent instead of leaving stale
-- entries until a later page.
--
-- `pg_trigger_depth() > 1` means the delete is a cascade (deleting an
-- auth.users row removes its documents). The queue and the projection both
-- cascade with the user, so there is nothing to refresh and enqueueing would
-- race the parent row deletion.
-- ---------------------------------------------------------------------------

create table public.wordbook_refresh_queue (
  user_id       uuid        not null references auth.users on delete cascade,
  language_code text        not null,
  lemma         text        not null,
  enqueued_at   timestamptz not null default clock_timestamp(),
  primary key (user_id, language_code, lemma)
);

comment on table public.wordbook_refresh_queue is
  'Transient purge work list: lemmas of a deleted document, drained in the same transaction.';

alter table public.wordbook_refresh_queue enable row level security;
-- No policies: only security-definer functions and the database owner touch it.
revoke all on table public.wordbook_refresh_queue from public, anon, authenticated;

-- The primary key (user_id, language_code, lemma) already serves both the
-- enqueue anti-join and the ordered drain.

create or replace function public.enqueue_wordbook_purge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    -- Cascade from auth.users: the projection rows are being deleted too.
    return old;
  end if;

  insert into public.wordbook_refresh_queue (user_id, language_code, lemma)
  select distinct old.user_id, o.language_code, o.lemma
  from public.word_occurrences o
  where o.user_id = old.user_id
    and o.document_id = old.id
  on conflict (user_id, language_code, lemma) do nothing;

  return old;
end;
$$;

revoke all on function public.enqueue_wordbook_purge()
  from public, anon, authenticated;

create trigger documents_enqueue_wordbook_purge
  before delete on public.documents
  for each row execute function public.enqueue_wordbook_purge();

create or replace function public.drain_wordbook_refresh_queue(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pairs jsonb;
begin
  -- Take the work list first, in one deleting statement, so a concurrent
  -- enqueue is either included now or left for the next drain (never lost).
  with taken as (
    delete from public.wordbook_refresh_queue q
    where q.user_id = p_user_id
    returning q.language_code, q.lemma
  )
  select jsonb_agg(
           jsonb_build_object(
             'userId', p_user_id,
             'languageCode', language_code,
             'lemma', lemma
           )
           order by language_code, lemma
         )
  into v_pairs
  from taken;

  if v_pairs is null then
    return;
  end if;

  perform public.refresh_wordbook_pairs(v_pairs);
end;
$$;

comment on function public.drain_wordbook_refresh_queue(uuid) is
  'Refreshes every lemma queued for a user by a document purge, then clears the queue.';

revoke all on function public.drain_wordbook_refresh_queue(uuid)
  from public, anon, authenticated;

create or replace function public.drain_wordbook_purge_queue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  for v_user_id in
    select distinct d.user_id from old_rows d order by d.user_id
  loop
    perform public.drain_wordbook_refresh_queue(v_user_id);
  end loop;

  return null;
end;
$$;

revoke all on function public.drain_wordbook_purge_queue()
  from public, anon, authenticated;

create trigger documents_drain_wordbook_purge
  after delete on public.documents
  referencing old table as old_rows
  for each statement execute function public.drain_wordbook_purge_queue();

-- Optional RPC for R3 clients. R2 clients delete directly; both paths end in
-- the triggers above.
create or replace function public.delete_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  delete from public.documents d
  where d.id = p_document_id
    and d.user_id = v_user_id;

  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.delete_document(uuid) is
  'Deletes the caller''s document; the purge trigger refreshes its wordbook lemmas.';

revoke all on function public.delete_document(uuid) from public, anon;
grant execute on function public.delete_document(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- replace_word_occurrences: refresh once after a real diff
--
-- Same hash short-circuit and document lock as Task 1. The only additions are:
--   * collect the old (language, lemma) pairs before the diff;
--   * collect the new pairs after it;
--   * refresh their union once, before returning;
--   * advance occurrences_updated_at only when occurrence rows really changed.
--
-- The function is now SECURITY DEFINER so it can call the internal refresh
-- functions, which are not executable by clients. Every statement is still
-- filtered by `user_id = auth.uid()`, so the tenant boundary is unchanged (the
-- Task 1 cross-tenant test covers it). The hash short-circuit returns before
-- any refresh, so a no-op push cannot write projection rows.
-- ---------------------------------------------------------------------------

create or replace function public.replace_word_occurrences(
  p_document_id uuid,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing_hash text;
  v_incoming_hash text;
  v_rows jsonb;
  v_old_pairs jsonb;
  v_new_pairs jsonb;
  v_pairs jsonb;
  v_real_change boolean;
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

  -- Same set, any row order: leave word_occurrences, documents, and the
  -- projection untouched.
  if v_existing_hash is not distinct from v_incoming_hash then
    return;
  end if;

  -- Old lemmas must be read before the diff removes them.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'languageCode', p.language_code,
               'lemma', p.lemma
             )
             order by p.language_code, p.lemma
           ),
           '[]'::jsonb
         )
  into v_old_pairs
  from (
    select distinct o.language_code, o.lemma
    from public.word_occurrences o
    where o.user_id = v_user_id
      and o.document_id = p_document_id
  ) p;

  v_rows := public.word_occurrence_canonical(p_rows);

  -- New lemmas come from the canonical payload (already deduplicated).
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'languageCode', p.language_code,
               'lemma', p.lemma
             )
             order by p.language_code, p.lemma
           ),
           '[]'::jsonb
         )
  into v_new_pairs
  from (
    select distinct
      entry->>'language_code' as language_code,
      entry->>'lemma' as lemma
    from jsonb_array_elements(v_rows) as entry
  ) p;

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

  -- One set-based refresh for the union of old and new (language, lemma)
  -- pairs. This is the only refresh call on the occurrence path.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'userId', v_user_id,
               'languageCode', p.language_code,
               'lemma', p.lemma
             )
             order by p.language_code, p.lemma
           ),
           '[]'::jsonb
         )
  into v_pairs
  from (
    select distinct
      pair->>'languageCode' as language_code,
      pair->>'lemma' as lemma
    from jsonb_array_elements(v_old_pairs || v_new_pairs) as pair
  ) p;

  if v_pairs <> '[]'::jsonb then
    perform public.refresh_wordbook_pairs(v_pairs);
  end if;

  -- A change to an initialized document is always a real diff. An
  -- uninitialized document (NULL hash) may only be claiming its hash: an empty
  -- payload for an already-empty document is not an occurrence change, so it
  -- must not claim occurrences_updated_at.
  v_real_change := v_existing_hash is not null
    or v_old_pairs <> '[]'::jsonb
    or v_new_pairs <> '[]'::jsonb;

  -- A real change owns a new hash. server_updated_at is left to the existing
  -- set_server_updated_at trigger; updated_at is left alone because this is not
  -- a content edit.
  update public.documents d
  set occurrences_hash = v_incoming_hash,
      occurrences_updated_at = case
        when v_real_change then clock_timestamp()
        else d.occurrences_updated_at
      end
  where d.user_id = v_user_id
    and d.id = p_document_id;
end;
$$;

revoke all on function public.replace_word_occurrences(uuid, jsonb)
  from public, anon;
grant execute on function public.replace_word_occurrences(uuid, jsonb)
  to authenticated;
