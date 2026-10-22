-- 문서의 updated_at 은 **클라이언트가 보낸 시각 중 늦은 쪽**을 쓴다.
--
-- 예전에는 내용·제목·휴지통 변경 때 서버가 now() 로 다시 찍었다. 그래서 A 가 T1 에
-- 고치고 먼저 동기화하면 서버 시각이 now() > T2 가 되고, T2(>T1)에 고친 B 의 편집이
-- '서버가 더 최신' 이라며 사라졌다. 동기화 시각이 편집 시각을 이기면 안 된다.
--
-- 폴더만 옮긴 UPDATE 는 열람 시각(updated_at)을 건드리지 않고 folder_updated_at 만
-- 쓴다. 그 인장도 now() 대신 클라이언트가 보낸 값을 믿되 뒤로 가지 않는다.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if old.title is not distinct from new.title
     and old.raw_text is not distinct from new.raw_text
     and old.language_code is not distinct from new.language_code
     and old.deleted_at is not distinct from new.deleted_at then
    new.folder_updated_at := greatest(new.folder_updated_at, old.folder_updated_at);
    new.updated_at := greatest(old.updated_at, coalesce(new.updated_at, old.updated_at));
    return new;
  end if;

  new.updated_at := greatest(old.updated_at, coalesce(new.updated_at, old.updated_at));
  return new;
end;
$$;
