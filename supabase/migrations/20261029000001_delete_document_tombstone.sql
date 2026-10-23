-- delete_document must record the deletion, not only remove the row (R3 final
-- review).
--
-- A bare DELETE is invisible to another device: it still has the document and
-- will push it back on its next cycle, resurrecting it. The tombstone is the
-- cross-device fact that the document is gone. Write both in one transaction so
-- a crash cannot leave a deleted row without its tombstone (or vice versa).
--
-- The purge triggers from 20261027000002 still run on the document delete and
-- refresh the wordbook projection. `deleteDocumentRemote` in the client now
-- calls this RPC instead of deleting the table directly.

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

  -- The earliest purge wins if this is a retry: a later timestamp would move
  -- the tombstone past another device's pull watermark.
  insert into public.document_tombstones (user_id, document_id, purged_at)
  select v_user_id, d.id, clock_timestamp()
  from public.documents d
  where d.id = p_document_id
    and d.user_id = v_user_id
  on conflict (user_id, document_id) do nothing;

  delete from public.documents d
  where d.id = p_document_id
    and d.user_id = v_user_id;

  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.delete_document(uuid) is
  'Deletes the caller''s document and writes its cross-device tombstone; the purge trigger refreshes its wordbook lemmas.';

revoke all on function public.delete_document(uuid) from public, anon;
grant execute on function public.delete_document(uuid) to authenticated;
