-- 등장 기록을 문서 단위로 **한 트랜잭션에서** 갈아끼운다.
--
-- 예전에는 클라이언트가 delete 요청을 보낸 뒤 insert 를 여러 번 보냈다. 중간에
-- 실패하면 서버에 그 문서의 기록이 비거나 일부만 남았고, 동시에 다른 기기가
-- 쓰면 같은 (문서, 단어, 표기) 행이 두 벌 생겼다.
--
-- 1) 먼저 기존 중복을 정리한다 — 가장 작은 id 만 남긴다.
delete from public.word_occurrences a
using public.word_occurrences b
where a.id > b.id
  and a.user_id = b.user_id
  and a.document_id = b.document_id
  and a.lemma = b.lemma
  and a.surface = b.surface;

-- 2) 같은 문서·단어·표기는 한 행만 존재하게 한다.
alter table public.word_occurrences
  add constraint word_occurrences_unique
  unique (user_id, document_id, lemma, surface);

-- 3) 지우기와 넣기를 한 함수 안에서 끝낸다. security invoker 라 RLS 가 그대로 적용된다.
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
end;
$$;

revoke all on function public.replace_word_occurrences(uuid, jsonb) from public;
grant execute on function public.replace_word_occurrences(uuid, jsonb) to authenticated;
