-- 별 스티커의 기울기와 색.
--
-- 별이 생길 때마다(붙일 때마다, 색을 바꿀 때마다) 새로 뽑는다. 꾸밈은 별의
-- 시각을 이긴 쪽의 것을 함께 쓴다 — 별과 따로 겨루면 기울기만 다른 별이 된다.
alter table public.word_states
  add column star_angle real not null default 0,
  add column star_color text not null default '#eab308';
