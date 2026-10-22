-- replace_word_occurrences 가 **문서 소유권**을 확인하게 한다.
--
-- 기존 함수는 delete/insert 에 user_id = auth.uid() 만 걸었다. 그래서 로그인한
-- 사용자가 자기 user_id 로 다른 사람의 document_id 를 가리키는 등장 기록 행을
-- 넣을 수 있었다. word_occurrences 의 RLS 는 행의 user_id 만 보므로 이를 막지
-- 못했고, 그 문서의 주인은 남의 기록을 자기 문서에서 보게 된다.
--
-- 이제 지우기 전에 문서가 호출자의 것인지 확인한다. security invoker 라
-- documents 의 RLS 도 그대로 적용되므로, 남의 문서는 select 자체가 되지 않아
-- exists 가 거짓이 되고 아래 예외로 끝난다. 문서가 없을 때와 남의 문서일 때를
-- 구분하지 않는 것도 의도적이다 — 문서 id 의 존재 여부를 알려주지 않는다.
create or replace function public.replace_word_occurrences(
  p_document_id uuid,
  p_rows jsonb
)
returns void
language plpgsql
security invoker
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1
    from public.documents d
    where d.id = p_document_id
      and d.user_id = auth.uid()
  ) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;

  delete from public.word_occurrences
  where user_id = auth.uid()
    and document_id = p_document_id;

  insert into public.word_occurrences (
    user_id, document_id, language_code, lemma, surface,
    char_start, char_end, sentence, occurrences_count
  )
  select
    auth.uid(),
    p_document_id,
    entry->>'language_code',
    entry->>'lemma',
    entry->>'surface',
    (entry->>'char_start')::int,
    (entry->>'char_end')::int,
    entry->>'sentence',
    coalesce((entry->>'occurrences_count')::int, 1)
  from jsonb_array_elements(p_rows) as entry;

  update public.documents
  set server_updated_at = now()
  where user_id = auth.uid()
    and id = p_document_id;
end;
$$;

revoke all on function public.replace_word_occurrences(uuid, jsonb) from public;
grant execute on function public.replace_word_occurrences(uuid, jsonb) to authenticated;
