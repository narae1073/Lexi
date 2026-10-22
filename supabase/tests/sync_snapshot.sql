-- Verify the sync snapshot RPC and server-side timestamps.
select sync_snapshot() is not null as has_snapshot;
select pg_get_functiondef('public.set_server_updated_at'::regproc) like '%clock_timestamp%' as trigger_uses_clock;
set role authenticated;
select sync_snapshot() is not null as authenticated_can_call;
reset role;
set role anon;
select sync_snapshot(); -- expected: permission denied
