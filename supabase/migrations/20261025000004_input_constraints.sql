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
--   select 'documents.title' as check, count(*) from public.documents where char_length(title) > 200
--   union all
--   select 'documents.raw_text', count(*) from public.documents where char_length(raw_text) > 100000
--   union all
--   select 'folders.name', count(*) from public.folders where char_length(name) > 200
--   union all
--   select 'word_states.lemma', count(*) from public.word_states where char_length(lemma) > 200
--   union all
--   select 'word_states.note', count(*) from public.word_states where char_length(note) > 5000
--   union all
--   select 'word_occurrences.lemma', count(*) from public.word_occurrences where char_length(lemma) > 200
--   union all
--   select 'word_occurrences.surface', count(*) from public.word_occurrences where char_length(surface) > 200
--   union all
--   select 'word_occurrences.sentence', count(*) from public.word_occurrences where char_length(sentence) > 5000;
--
-- 하나라도 0 이 아닌 행이 나오면 **멈춘다.** 지우거나 자르지 말고 사용자에게
-- 보고한다. 데이터를 정리한 뒤에만 이 마이그레이션과 이후 validate 를 진행한다.
--
-- 아래 제약 중 preflight 가 다루지 않는 것들도 staging 에서 함께 확인한다:
--
--   select 'word_states.star_angle', count(*) from public.word_states
--    where star_angle < 0 or star_angle > 360
--   union all
--   select 'word_states.star_color', count(*) from public.word_states
--    where star_color !~ '^#[0-9a-fA-F]{6}$'
--   union all
--   select 'word_states.presses', count(*) from public.word_states
--    where known_presses < 0 or unsure_presses < 0 or unknown_presses < 0
--   union all
--   select 'word_occurrences.language_code', count(*) from public.word_occurrences
--    where language_code !~ '^[a-z]{2}(-[A-Za-z]{2})?$'
--   union all
--   select 'word_occurrences.occurrences_count', count(*) from public.word_occurrences
--    where occurrences_count < 1
--   union all
--   select 'word_occurrences.span', count(*) from public.word_occurrences
--    where char_end < char_start or char_end - char_start > 1000;
--
-- 주의: 현재 클라이언트의 randomStarAngle() 은 -25..25 를 만든다. 이 제약을
-- 적용하면 새로 붙이는 별의 약 절반이 거부된다. staging 검증 전에 각도 생성
-- 규칙(또는 이 범위)을 먼저 합의해야 한다 — 이 작업에서는 제약을 임의로 바꾸지
-- 않는다.
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
  add constraint word_states_star_angle_range check (star_angle >= 0 and star_angle <= 360) not valid,
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
--   1. 위 preflight 와 추가 검사가 모두 0 행을 반환한다.
--   2. 새 잘못된 행이 실제로 거부되는지 확인한다 (예: 201자 title insert 가
--      check violation 으로 실패). 이때 트랜잭션은 rollback 한다.
--   3. 기존 행이 그대로 읽히는지 확인한다 — NOT VALID 는 기존 행을 검사하지 않는다.
--   4. 그 뒤에만 제약별로 validate 한다:
--        alter table public.documents validate constraint documents_title_len;
--        ... (각 제약 이름으로 반복)
--
-- validate 는 전체 테이블을 스캔하며 잠금을 잡는다. 사용량이 적은 시간에 한다.
-- ---------------------------------------------------------------------------
