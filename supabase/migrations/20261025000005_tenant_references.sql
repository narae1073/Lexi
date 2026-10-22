-- 참조 컬럼에도 테넌트 경계를 세운다 — 직접 PostgREST 쓰기에 대한 방어 심층화.
--
-- documents.folder_id 와 word_occurrences.document_id 는 지금까지 FK 만 걸려
-- 있었고, RLS 는 행의 user_id 만 보았다. 그래서 로그인한 사용자가 자기 user_id
-- 로 다른 사람의 folder_id / document_id 를 가리키는 행을 직접 넣거나 고칠 수
-- 있었다. 그 문서의 주인은 남의 폴더에 놓인 문서, 남의 문서에 달린 등장 기록을
-- 보게 된다.
--
-- 여기서는 기존 "own" 정책(permissive)을 그대로 두고 restrictive 정책을 더한다.
-- permissive 는 OR, restrictive 는 AND 로 합쳐지므로 두 조건을 모두 만족해야
-- 한다. replace_word_occurrences 의 명시적 소유권 검사(20261025000003)는 그대로
-- 두고, 이 마이그레이션은 RPC 를 거치지 않는 직접 쓰기를 막는다.
--
-- 정책은 INSERT / UPDATE 에만 붙인다. SELECT 와 DELETE 의 가시 범위는 바꾸지
-- 않는다. UPDATE 정책에 USING 을 두지 않은 것은 의도적이다 — USING 이 없으면
-- 기존 행의 가시 범위는 permissive "own" 정책이 그대로 정하고, WITH CHECK 만
-- 새 값에 적용된다 (PostgreSQL 17, CREATE POLICY).

-- ---------------------------------------------------------------------------
-- folders.parent_id 검사용 helper
--
-- folders 의 정책 안에서 folders 를 다시 select 하면 같은 정책이 재귀한다.
-- security definer 로 그 select 만 테이블 소유자 권한으로 실행해 재귀를 끊는다.
-- search_path 는 고정하고, anon/public 실행 권한은 회수한다.
-- ---------------------------------------------------------------------------

create or replace function public.folder_is_owned_by(p_folder_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.folders f
    where f.id = p_folder_id
      and f.user_id = p_user_id
  );
$$;

revoke all on function public.folder_is_owned_by(uuid, uuid) from public, anon;
grant execute on function public.folder_is_owned_by(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- documents.folder_id — 남의 폴더를 가리킬 수 없다. NULL 은 폴더 없음이다
-- ---------------------------------------------------------------------------

create policy "documents folder owner" on public.documents
  as restrictive for insert
  with check (
    folder_id is null or exists (
      select 1 from public.folders f
      where f.id = folder_id and f.user_id = auth.uid()
    )
  );

create policy "documents folder owner update" on public.documents
  as restrictive for update
  with check (
    folder_id is null or exists (
      select 1 from public.folders f
      where f.id = folder_id and f.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- word_occurrences.document_id — 남의 문서를 가리킬 수 없다
-- ---------------------------------------------------------------------------

create policy "word_occurrences document owner" on public.word_occurrences
  as restrictive for insert
  with check (
    exists (
      select 1 from public.documents d
      where d.id = document_id and d.user_id = auth.uid()
    )
  );

create policy "word_occurrences document owner update" on public.word_occurrences
  as restrictive for update
  with check (
    exists (
      select 1 from public.documents d
      where d.id = document_id and d.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- folders.parent_id — 남의 폴더를 부모로 삼을 수 없다. NULL 은 최상위다
-- ---------------------------------------------------------------------------

create policy "folders parent owner" on public.folders
  as restrictive for insert
  with check (
    parent_id is null or public.folder_is_owned_by(parent_id, auth.uid())
  );

create policy "folders parent owner update" on public.folders
  as restrictive for update
  with check (
    parent_id is null or public.folder_is_owned_by(parent_id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 기존 데이터는 건드리지 않는다.
--
-- restrictive 정책은 새 INSERT/UPDATE 에만 적용된다. 이미 다른 사용자의 폴더·
-- 문서를 가리키는 행이 있어도 지우거나 고치지 않는다. 다만 그런 행은 앞으로
-- UPDATE 가 거부되므로(새 값이 여전히 남의 것을 가리키기 때문), 동기화가 반복
-- 실패할 수 있다. 적용 전에 staging 에서 아래 읽기 전용 검사로 규모를 확인하고,
-- 필요하면 **사용자와 상의해** 해당 행의 참조를 NULL 로 바꾸거나 올바른 소유자
-- 행으로 옮긴다. 이 마이그레이션은 어떤 정리도 하지 않는다.
--
--   select 'documents.folder_id' as check, count(*) from public.documents d
--     join public.folders f on f.id = d.folder_id
--    where f.user_id <> d.user_id
--   union all
--   select 'word_occurrences.document_id', count(*) from public.word_occurrences o
--     join public.documents d on d.id = o.document_id
--    where d.user_id <> o.user_id
--   union all
--   select 'folders.parent_id', count(*) from public.folders f
--     join public.folders p on p.id = f.parent_id
--    where p.user_id <> f.user_id;
--
-- 두 사용자 수동 검사(staging, 적용 후):
--   - B 가 A 의 folder_id 로 documents 를 insert/update → 거부
--   - B 가 A 의 document_id 로 word_occurrences 를 insert/update → 거부
--   - B 가 A 의 parent_id 로 folders 를 insert/update → 거부
--   - B 가 자기 folder/document/parent 로 하는 같은 작업 → 성공
--   - 검사 후 테스트 사용자와 그 데이터를 정리한다.
-- ---------------------------------------------------------------------------
