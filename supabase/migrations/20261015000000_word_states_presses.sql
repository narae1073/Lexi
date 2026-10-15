-- 퀴즈에서 상태 단추를 누른 횟수.
--
-- 상태와 다른 것을 센다: '모름' 인 단어에서 '앎' 을 누르면 상태는 전이 규칙에 따라
-- '헷갈림' 이 되지만, 누른 것은 '앎' 이므로 '앎' 을 센다 — 상태를 세면 이 경우가
-- '앎' 에 영영 안 잡힌다. 읽기 화면·단어장의 표시는 세지 않는다 (퀴즈에서만 센다).
--
-- 지금은 저장만 해 두고 화면에 쓰지 않는다 (나중에 쓰려고).
-- 기기 간 병합은 seen_count 와 같은 규칙(큰 값)이다 — 두 기기에서 누른 것을
-- 정확히 더하지는 않는다.
alter table public.word_states
  add column known_presses int not null default 0,
  add column unsure_presses int not null default 0,
  add column unknown_presses int not null default 0;
