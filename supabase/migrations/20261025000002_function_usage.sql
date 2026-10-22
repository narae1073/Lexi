-- Edge Function 익명 사용량 쿼터 (Release 3).
--
-- 번역·사전 함수는 로그인 없이도 호출할 수 있어, 설치 ID / IP / 전역 단위로
-- 호출 횟수를 제한한다. 버킷 이름은 _shared/quota.ts 에서 해시로 만들어지므로
-- 이 표에는 설치 ID 나 IP 원문이 남지 않는다.
--
-- 집계는 service_role 만 실행할 수 있는 RPC 안에서 한 문장으로 끝낸다.
-- "읽고 → 비교하고 → 쓰기" 를 클라이언트가 나눠 하면 동시 요청에서 한도를
-- 넘길 수 있기 때문이다. anon/authenticated 는 표에 직접 접근할 수 없고
-- (RLS 정책 없음 + 권한 회수), 함수 실행 권한도 service_role 에만 준다.
--
-- 행은 (bucket, window_start) 마다 하나씩 늘어난다. 오래된 창의 정리는
-- Release 4 로 미뤘고, 그때를 위해 window_start 인덱스를 미리 둔다.

create table public.function_usage (
  bucket       text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (bucket, window_start)
);
-- 향후 창 단위 정리(delete ... where window_start < ...)를 위한 인덱스.
create index function_usage_window_idx on public.function_usage (window_start);
alter table public.function_usage enable row level security;
-- 정책을 만들지 않는다. service_role 은 RLS 를 우회하고, 나머지는 접근할 수 없다.
revoke all on table public.function_usage from anon, authenticated;

-- 고정 창(fixed window) 하나를 원자적으로 소비한다. 창 시작은 UTC epoch 기준으로
-- 내림해 경계가 요청마다 흔들리지 않게 한다. 한도를 넘겨도 count 는 계속 올라가
-- 거부된 요청이 다음 창에 영향을 주지 않는다.
create or replace function public.consume_function_quota(
  p_bucket text,
  p_limit int,
  p_window_seconds int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count int;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then return false; end if;
  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  insert into public.function_usage (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
  do update set count = public.function_usage.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;

revoke all on function public.consume_function_quota(text, int, int) from public, anon, authenticated;
grant execute on function public.consume_function_quota(text, int, int) to service_role;
