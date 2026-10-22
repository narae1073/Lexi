-- 표시를 없앤 단어는 행을 지우지 않고 status 를 비운다.
--
-- 상태 행에는 즐겨찾기·메모·퀴즈 횟수가 함께 있다. 행을 지우면 그 기록이 서버에서
-- 사라지고, 다른 기기가 옛 상태를 다시 올리면 '없앰' 과 '되살림' 이 영원히 번갈아
-- 일어난다. status = null 인 행을 남겨 없앰 자체를 동기화한다.
alter table public.word_states
  alter column status drop not null,
  alter column status drop default;
