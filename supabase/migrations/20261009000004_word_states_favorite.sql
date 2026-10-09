-- 단어 즐겨찾기 (팝오버 제목 옆 ☆/★).
--
-- 상태와 독립이라 별도 시각으로 병합한다: A 기기에서 별을 뗀 뒤 B 기기에서
-- 상태를 바꾸면 B 행이 더 늦어 별이 되살아난다. 별은 별의 시각으로만 겨룬다.
alter table public.word_states
  add column is_favorite boolean not null default false,
  add column favorite_updated_at timestamptz not null default now();
