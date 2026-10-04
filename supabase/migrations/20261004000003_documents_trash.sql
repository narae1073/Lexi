-- 문서 휴지통 (soft delete)
--
-- 왜 바로 지우지 않는가: 실수로 지운 문서를 되살릴 방법이 없다. 특히 이 앱에서는
-- 문서를 열어 단어를 기록해 둔 것이 learning 상태의 근거라, 지우면 어디에도 안 남는다.
--
-- deleted_at 이 NULL 이면 살아 있는 문서다. 기존 행은 영향을 받지 않는다.

alter table public.documents
  add column if not exists deleted_at timestamptz;

comment on column public.documents.deleted_at is
  '휴지통에 버린 시각. NULL 이면 살아 있는 문서.';

-- 목록을 자주 정렬하므로 부분 인덱스를 둔다
create index if not exists documents_user_deleted_idx
  on public.documents (user_id, deleted_at, updated_at desc);