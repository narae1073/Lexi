-- Verify the sync snapshot RPC and server-side timestamps.
-- Positive checks raise on failure; the final anon call must be denied.
do $$
begin
  if sync_snapshot() is null then
    raise exception 'sync_snapshot() returned null';
  end if;
  if pg_get_functiondef('public.set_server_updated_at'::regproc) not like '%clock_timestamp%' then
    raise exception 'set_server_updated_at does not use clock_timestamp()';
  end if;
end
$$;

set role authenticated;
do $$
begin
  if sync_snapshot() is null then
    raise exception 'authenticated cannot read sync_snapshot()';
  end if;
end
$$;
reset role;

set role anon;
select sync_snapshot(); -- expected: permission denied
