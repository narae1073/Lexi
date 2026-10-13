-- 폴더 (문서 정리, 개선사항.txt)
--
-- 어떻게 옮기는가가 어디에 두느냐만큼 중요하다. documents.updated_at 은
-- '마지막으로 본 시각'이라 문서 목록이 그 순서로 정렬한다. 폴더로 옮기는 일이
-- 그 시각을 다시 찍으면, 옮긴 문서가 목록 맨 위로 술렁인다.
--
-- 그래서 두 가지를 함께 한다.
--   1) 루트에만 걸려 있던 set_updated_at 을 고쳐, 폴더 바꾸기만 일어난
--      UPDATE 는 updated_at 을 건드리지 않고 folder_updated_at 을 찍는다.
--      (별의 기록이 word_states.favorite_updated_at 으로 따로 놀던 것과 같은 모양이다)
--   2) 문서 옮김은 folder_updated_at 값으로 승부를 본다 — 언제 열었는가와
--      무관하게, 늦게 옮긴 쪽이 이긴다.

-- ---------------------------------------------------------------------------
-- 폴더
-- ---------------------------------------------------------------------------

create table public.folders (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users on delete cascade,
  /** 빈 이름 폴더는 목록에서 구분할 수 없다 */
  name        text        not null check (length(btrim(name)) > 0),
  /** 중첩 폴더 — 최상위는 NULL. parent_id 는 폴더 삭제에 묶이지 않는다 (soft delete) */
  parent_id   uuid        references public.folders on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists folders_user_updated_idx
  on public.folders (user_id, updated_at desc);

-- 문서의 어느 폴더에 놓였는가. NULL 이면 (아직) 폴더에 없다
alter table public.documents
  add column if not exists folder_id uuid references public.folders on delete set null;

-- 폴더로 옮긴 시각 — 열람 시각(updated_at)과는 별개의 인장이다
alter table public.documents
  add column if not exists folder_updated_at timestamptz;

create index if not exists documents_user_folder_idx
  on public.documents (user_id, folder_id);

comment on column public.documents.folder_id is
  '문서가 놓인 폴더. NULL 이면 폴더에 없다.';
comment on column public.documents.folder_updated_at is
  '문서를 폴더로 옮긴 시각. 별도의 인장이라 열람 시각(updated_at)을 다시 찍지 않는다.';

-- ---------------------------------------------------------------------------
-- RLS — 모든 사용자 데이터와 같은 규칙이다
-- ---------------------------------------------------------------------------

alter table public.folders enable row level security;

create policy "folders own" on public.folders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- set_updated_at — 폴더 바꾸기만 일어난 UPDATE 는 updated_at 을 찍지 않는다
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- 내용과 휴지통 상태가 그대로이고 folder_id 만 달라졌으면, 폴더를 옮긴 것이다.
  -- 옮긴 시각은 folder_updated_at 에 찍는다 — '마지막으로 본 시각'은 건드리지 않는다.
  if old.title is not distinct from new.title
     and old.raw_text is not distinct from new.raw_text
     and old.language_code is not distinct from new.language_code
     and old.deleted_at is not distinct from new.deleted_at then
    -- 폴더 인장은 늦게 찍힌 쪽이 이긴다 (word_states.favorite_updated_at 와 같은 규칙).
    -- 클라이언트가 보낸 값이 더 늦으면 그것을 믿고, 없거나 옛 값이면 지금 찍는다.
    -- greatest 는 NULL 을 무시하므로, 한 번도 옮긴 적 없는 행(old NULL)에도 통한다.
    new.folder_updated_at := greatest(
      new.folder_updated_at,
      old.folder_updated_at,
      now()
    );
    -- updated_at 도 되돌아가지 않게 한다 — 이 기기에서 더 늦게 열었으면 그 사실을
    -- 서버도 알아야 한다. 서버 것을 유지하면 이 문서는 매 동기화마다 '보낼 것'으로
    -- 남아 영영 조용해지지 않는다.
    new.updated_at := greatest(old.updated_at, coalesce(new.updated_at, old.updated_at));
    return new;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
