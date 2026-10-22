-- 사용자 입력의 길이·횟수에 서버 상한을 둔다.
--
-- 앱은 이미 화면에서 상한을 보여 주지만, 그것은 브라우저 안의 약속일 뿐이다.
-- API 를 직접 부르거나 다른 클라이언트를 쓰면 임의 길이의 행을 넣을 수 있고,
-- 그런 행 하나가 동기화·화면 렌더링을 막는다. 여기서 마지막 문지기를 세운다.
--
-- **NOT VALID** 로 추가한다. 새 행은 즉시 검사하지만, 이미 있는 행은 건드리지
-- 않는다. 기존 데이터를 지우거나 잘라 내지 않고, 검증(validate)도 이 마이그레이션
-- 에서 하지 않는다 — 먼저 아래 preflight 로 위반 행을 사람이 확인하고 정리한 뒤,
-- 별도의 후속 작업에서 validate 한다.
--
-- 결과적으로 제약은 "새로 들어오는 잘못된 행" 을 막고, 기존 행은 그대로 읽힌다.
-- NOT VALID 제약도 INSERT/UPDATE 에는 적용되므로 새 행은 이 상한을 지켜야 한다.

-- ---------------------------------------------------------------------------
-- Preflight — staging 에서 마이그레이션 적용 **전에** 실행한다.
-- 이 저장소에는 실행할 live 프로젝트가 없어 여기서는 실행하지 않았다.
--
-- 아래 검사는 **모든 새 제약**을 그대로 거울처럼 옮긴 것이다 — 상한뿐 아니라
-- 하한(빈 제목·폴더 이름·본문·lemma·surface)과 나머지 형식·범위 검사도 포함한다.
-- 하나라도 count 가 0 이 아니면 그 행들은 update/sync 에서 거부되어 wedge 가 된다.
--
--   select 'documents.title (btrim 1..200)' as check, count(*) from public.documents
--    where char_length(btrim(title)) not between 1 and 200
--   union all
--   select 'documents.raw_text (1..100000)', count(*) from public.documents
--    where char_length(raw_text) not between 1 and 100000
--   union all
--   select 'folders.name (btrim 1..200)', count(*) from public.folders
--    where char_length(btrim(name)) not between 1 and 200
--   union all
--   select 'word_states.lemma (1..200)', count(*) from public.word_states
--    where char_length(lemma) not between 1 and 200
--   union all
--   select 'word_states.note (null or <=5000)', count(*) from public.word_states
--    where note is not null and char_length(note) > 5000
--   union all
--   select 'word_states.presses (>=0)', count(*) from public.word_states
--    where known_presses < 0 or unsure_presses < 0 or unknown_presses < 0
--   union all
--   select 'word_states.star_angle (-360..360)', count(*) from public.word_states
--    where star_angle < -360 or star_angle > 360
--   union all
--   select 'word_states.star_color (#rrggbb)', count(*) from public.word_states
--    where star_color !~ '^#[0-9a-fA-F]{6}$'
--   union all
--   select 'word_occurrences.language_code (xx or xx-YY)', count(*) from public.word_occurrences
--    where language_code !~ '^[a-z]{2}(-[A-Za-z]{2})?$'
--   union all
--   select 'word_occurrences.lemma (1..200)', count(*) from public.word_occurrences
--    where char_length(lemma) not between 1 and 200
--   union all
--   select 'word_occurrences.surface (1..200)', count(*) from public.word_occurrences
--    where char_length(surface) not between 1 and 200
--   union all
--   select 'word_occurrences.sentence (<=5000)', count(*) from public.word_occurrences
--    where char_length(sentence) > 5000
--   union all
--   select 'word_occurrences.occurrences_count (>=1)', count(*) from public.word_occurrences
--    where occurrences_count < 1
--   union all
--   select 'word_occurrences.span (>=0 and <=1000)', count(*) from public.word_occurrences
--    where char_end < char_start or char_end - char_start > 1000;
--
-- btrim 은 기본적으로 ASCII 공백만 제거한다. 탭·개행만 있는 이름은 제약을
-- 통과하므로 필요하면 별도로 확인한다.
--
-- count 가 하나라도 0 이 아니면 **멈춘다.** 지우거나 자르지 말고 사용자에게
-- 보고한다. 데이터를 정리한 뒤에만 이 마이그레이션과 이후 validate 를 진행한다.
--
-- 각도는 **부호 있는 기울기** 다 — 별을 왼쪽으로도 기울이므로 음수가 정상이다.
-- 클라이언트의 randomStarAngle() 은 -25..25 를 만들고, 범위는 그보다 넓게
-- -360..360 을 허용한다. 0..360 으로 두면 새로 붙이는 별의 약 절반이 거부되고
-- 동기화가 막힌다. CSS transform 의 기울기 단위(도)를 그대로 쓴다.
-- ---------------------------------------------------------------------------

alter table public.documents
  add constraint documents_title_len check (char_length(btrim(title)) between 1 and 200) not valid,
  add constraint documents_raw_text_len check (char_length(raw_text) between 1 and 100000) not valid;

alter table public.folders
  add constraint folders_name_len check (char_length(btrim(name)) between 1 and 200) not valid;

alter table public.word_states
  add constraint word_states_lemma_len check (char_length(lemma) between 1 and 200) not valid,
  add constraint word_states_note_len check (note is null or char_length(note) <= 5000) not valid,
  add constraint word_states_press_nonnegative check (
    known_presses >= 0 and unsure_presses >= 0 and unknown_presses >= 0
  ) not valid,
  add constraint word_states_star_angle_range check (star_angle >= -360 and star_angle <= 360) not valid,
  add constraint word_states_star_color_format check (star_color ~ '^#[0-9a-fA-F]{6}$') not valid;

alter table public.word_occurrences
  add constraint word_occurrences_language_format check (language_code ~ '^[a-z]{2}(-[A-Za-z]{2})?$') not valid,
  add constraint word_occurrences_lemma_len check (char_length(lemma) between 1 and 200) not valid,
  add constraint word_occurrences_surface_len check (char_length(surface) between 1 and 200) not valid,
  add constraint word_occurrences_sentence_len check (char_length(sentence) <= 5000) not valid,
  add constraint word_occurrences_count_positive check (occurrences_count >= 1) not valid,
  add constraint word_occurrences_span_sane check (char_end >= char_start and char_end - char_start <= 1000) not valid;

-- ---------------------------------------------------------------------------
-- Deferred staging checks — 위 검사를 통과한 뒤, validate 하기 전에 확인한다.
--
--   1. 위 preflight 의 모든 count 가 0 이다.
--   2. 새 잘못된 행이 실제로 거부되는지 확인한다 (예: 201자 title insert 가
--      check violation 으로 실패). 이때 트랜잭션은 rollback 한다.
--   3. 기존 행이 그대로 읽히는지 확인한다 — NOT VALID 는 기존 행을 검사하지 않는다.
--   4. 그 뒤에만 제약별로 validate 한다:
--        alter table public.documents validate constraint documents_title_len;
--        ... (각 제약 이름으로 반복)
--
-- validate 는 전체 테이블을 스캔하며 잠금을 잡는다. 사용량이 적은 시간에 한다.
-- ---------------------------------------------------------------------------
