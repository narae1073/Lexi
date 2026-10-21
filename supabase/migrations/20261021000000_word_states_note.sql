-- 단어 메모 — 어원·연상·내 예문을 직접 적어 두는 자리.
--
-- 상태·별과 독립이라 자기 시각(note_updated_at)으로 병합한다. 메모를 고친 쪽이
-- 이기고, 비우면 null 이 되어 '지운 메모' 가 되살아나지 않는다.
--
-- note_updated_at 이 null 인 행은 "메모를 고친 적 없다" 는 뜻이다 — 마지막으로
-- 본 시각으로 채우면 상태만 바꾼 기기가 다른 기기의 메모를 지워 버린다.
alter table public.word_states
  add column note text,
  add column note_updated_at timestamptz;
