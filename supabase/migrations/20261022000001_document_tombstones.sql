-- 완전 삭제한 문서의 묘비.
--
-- 문서 행을 서버에서 지우면 다른 기기는 그 문서를 '로컬에만 있는 것' 으로 보고
-- 다시 올려 버린다. 지운 사실 자체를 동기화해야 되살아나지 않는다.
-- 행은 영원히 남긴다 — id 는 uuid 라 다시 쓰이지 않고, 목록도 작다.
create table public.document_tombstones (
  user_id     uuid        not null references auth.users on delete cascade,
  document_id uuid        not null,
  purged_at   timestamptz not null default now(),
  primary key (user_id, document_id)
);

alter table public.document_tombstones enable row level security;

create policy "document_tombstones own" on public.document_tombstones
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
