create or replace function public.set_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace function public.sync_snapshot()
returns timestamptz
language sql
volatile
security invoker
set search_path = public
as $$ select clock_timestamp(); $$;

revoke all on function public.sync_snapshot() from public, anon;
grant execute on function public.sync_snapshot() to authenticated;
