-- word_occurrences 에 등장 횟수를 담는다.
--
-- 왜 필요한가: 서버는 표기 하나당 한 줄이라, 같은 단어가 몇 번 나왔는지를
-- 알 수 없다. 그러면 새 기기에서 단어장을 보면 ×N 이 표기 개수(대부분 1)로
-- 보여 실제와 어긋난다. 문서를 직접 열면 다시 계산되어 정확해지지만,
-- 열지 않은 문서는 계속 틀린다.
--
-- 기본값 1: 기존 행은 횟수를 모른다. 1 이 가장 덜 틀리는 값이다.

alter table public.word_occurrences
  add column if not exists occurrences_count int not null default 1;

comment on column public.word_occurrences.occurrences_count is
  '이 표기가 등장한 횟수. 서버가 표기별로 한 줄씩 저장하므로 문서의 첫 등장 위치만 대표로 갖는다.';