# 구현 계획 — 단어 학습 번역기

`plan.txt`의 9개 요구사항을 구현 가능한 설계로 펼친 문서.

---

## 1. 확정된 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 프론트엔드 | React 19 + TypeScript + Vite | PWA로 배포 |
| 스타일 | Tailwind CSS | 상태별 색상 토큰 정의에 적합 |
| 상태 관리 | Zustand | 문서·단어 상태·언어 선택 |
| 백엔드 | Supabase (Auth + Postgres + Edge Functions) | API 키 서버 보관, 동기화 |
| 번역 | Google Cloud Translation API v2 | Edge Function 경유 |
| 사전 | freedictionaryapi.com (English Wiktionary 기반, 키 불필요·무료) | 언어별 캐시, 출처 표기 필요 |
| 모바일 | vite-plugin-pwa → 추후 Capacitor | 앱스토어 제출 경로 열어둠 |

**언어 방향**: 배울 언어(target)의 글을 입력 → 뜻은 영어로 표시. 예: 영어 글 → 영어 뜻 + 영어 발음, 일본어 글 → 영어 뜻.

---

## 2. 요구사항 매핑 (plan.txt 추적성)

| # | plan.txt 요구 | 구현 위치 |
|---|---|---|
| 1 | 모바일 앱 출시 가능성 확보, 어디서든 이어서 학습 | PWA 매니페스트 + Capacitor 적용 가능한 `src/` 분리. 학습 데이터는 전부 서버(Supabase)에 저장 |
| 2 | 메인에서 언어 선택 → 텍스트 입력 → 화면 출력 | `features/languages/` → `features/reader/` |
| 3 | 단어 클릭 시 상태(○◐●) + 사전 버튼을 담은 작은 박스 | `WordPopover` (폭 ~200px) |
| 4 | 3단계 상태 구분 + 색상, 아는 단어는 검정 | `lib/color.ts` 상태→색상 매핑 테이블 |
| 5 | 언어별 사전 저장, 배울 언어만 목록에 표시 | `user_languages` 테이블 + `SUPPORTED_LANGUAGES` 화이트리스트 |
| 6 | 문장 선택 가능, 호버 박스가 단어 것보다 큼, 클릭 시 문장 번역 표시 | `SentencePopover` (폭 ~360px) + `SentenceTranslator` |
| 7 | 텍스트가 길면 페이지 구분 | `lib/paginate.ts`, 페이지당 글자 수 기준 |
| 8 | 하단 상태 바에 단어 수·상태별 통계 | `StatusBar` |
| 9 | 단어장 (메인 + 문서 내 접근, 언어 선택 후 상태별 목록) | `features/wordbook/` |

---

## 3. 아키텍처

```
┌─────────────────────────────────────────────┐
│  PWA (React)                                 │
│  ┌──────────┬───────────┬──────────────────┐ │
│  │ Languages│  Reader   │     Wordbook     │ │
│  │          │ tokenizer │                  │ │
│  │          │ +popovers │                  │ │
│  └──────────┴─────┬─────┴────────┬─────────┘ │
│                  │              │           │
│           Zustand Store (wordStates, docs)   │
│                  │              │           │
│           Supabase JS ──────────┘           │
└──────────────────┬──────────────────────────┘
                   │ (API 키는 클라이언트에 없음)
        ┌──────────▼───────────┐
        │  Supabase Edge Fn   │
        │  ├─ translate       │──► Google Cloud Translation
        │  └─ dictionary      │──► Google Dictionary API
        └──────────┬───────────┘
                   ▼
        ┌──────────────────────────────┐
        │ Postgres                      │
        │  documents / word_states /    │  ← 캐시 + 원본 저장소
        │  word_occurrences / *_cache   │
        └──────────────────────────────┘
```

**핵심 원칙**
- API 키는 절대 클라이언트 번들에 넣지 않는다. 모든 번역/사전 요청은 Edge Function 경유.
- 번역·사전 결과는 Postgres에 캐시. 같은 단어/문장은 두 번째부터 비용 0.
- 단어 상태는 **전역(언어별)** — 같은 단어는 어떤 문서에서 발견해도 같은 상태.

---

## 4. 데이터 모델

```sql
-- 사용자가 등록한 배울 언어 (plan.txt 5줄: 이 목록만 화면에 노출)
create table user_languages (
  user_id       uuid references auth.users on delete cascade,
  language_code text not null,          -- BCP-47 'en', 'ja', ...
  created_at    timestamptz default now(),
  primary key (user_id, language_code)
);

-- 입력한 텍스트 문서
create table documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users on delete cascade,
  title       text not null default '제목 없음',
  language_code text not null,
  raw_text    text not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index on documents (user_id, updated_at desc);

-- 단어 상태: 전역 저장 (문서 무관)
create type word_status as enum ('known', 'unsure', 'unknown');

create table word_states (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users on delete cascade,
  language_code text not null,
  lemma        text not null,           -- 정규화된 원형 (lowercase, lemma 추출)
  status       word_status not null default 'unsure',
  seen_count   int not null default 1,
  first_seen_at timestamptz default now(),
  last_seen_at  timestamptz default now(),
  unique (user_id, language_code, lemma)
);

-- 단어가 실제로 등장한 위치 + 예문 (단어장의 문맥 제공)
create table word_occurrences (
  id          bigserial primary key,
  user_id     uuid references auth.users on delete cascade,
  document_id uuid references documents on delete cascade,
  language_code text not null,
  lemma       text not null,
  surface     text not null,            -- 원문 표기 (원형과 다를 수 있음)
  char_start  int not null,
  char_end    int not null,
  sentence    text not null
);
create index on word_occurrences (user_id, language_code, lemma);

-- 번역 캐시 (동일 문장은 재호출 없음)
create table translation_cache (
  source_language text not null,
  target_language text not null default 'en',
  source_hash     text not null,        -- md5(source_text)
  source_text     text not null,
  translated_text text not null,
  created_at      timestamptz default now(),
  primary key (source_language, target_language, source_hash)
);

-- 사전 캐시: 언어별로 나눠 저장
create table dictionary_entries (
  language_code text not null,
  lemma         text not null,
  payload       jsonb not null,         -- {phonetic, meanings:[{pos, definitions, examples}]}
  provider      text not null,          -- 'google-dictionary' | 'dictionaryapi.dev'
  fetched_at    timestamptz default now(),
  primary key (language_code, lemma)
);
```

RLS: 모든 테이블에 `auth.uid() = user_id` 정책. 캐시 테이블은 읽기만 허용(anon) + 서비스 계정만 쓰기.

---

## 5. 핵심 기술 설계

### 5.1 토크나이저 (`src/features/reader/tokenizer.ts`)

원문을 **공백을 그대로 보존**하면서 단어 단위로 쪼개야 화면이 깨지지 않는다. 문서의 오프셋이 곧 좌표이므로 모든 인덱스는 원문 기준 `char_start`/`char_end`.

```ts
type Segment =
  | { type: 'word'; start: number; end: number; text: string; lemma: string }
  | { type: 'text'; start: number; end: number; text: string };

type Sentence = { start: number; end: number; index: number };
```

알고리즘:
1. **문장 경계 先 계산** — `[.!?…。！？\n]` + 후행 공백 기준. CJK 문장부호 포함.
2. **Intl.Segmenter**(granularity `'word'`)로 언어별 분절.
   - 영어 계열: `\p{L}\p{M}\p{N}` + 어포스트로피·하이픈 유지 (`don't`, `well-known`)
   - CJK(ja/zh/ko): Intl.Segmenter가 처리, 미지원 브라우저는 한자 단위 폴백
3. **lemma 정규화** — 소문자 + 트레iling 소유격/복수형 제거 (기본 규칙만,，不代表별 완성형 사전은 범위 밖)
4. **검색** — `lemma -> word_states.status` 맵을 만들어 색상 클래스 결정. O(1).

### 5.2 렌더링

```tsx
<div className="whitespace-pre-wrap" onMouseUp={handleSelection}>
  {segments.map(s =>
    s.type === 'word'
      ? <WordChip key={s.start} start={s.start} className={colorOf(s.lemma)}>{s.text}</WordChip>
      : <Fragment key={s.start}>{s.text}</Fragment>
  )}
</div>
```
- `key`는 `char_start` — 문서 텍스트는 세션 중 불변이므로 안정적. 편집 시 전체 재분절.
- 긴 문서는 페이지 단위로 렌더 → 페이지당 DOM 노드 수 제한 (가상화까지는 불필요).

### 5.3 호버 박스 (Popover)

- `createPortal`로 `document.body`에 렌더, `position: fixed`
- 좌표는 `target.getBoundingClientRect()` 기준, viewport 밖으로 나가면 flip/clamp
- 외부 클릭·ESC·스크롤 시 닫힘 (`ResizeObserver`로 위치 재계산)

**단어 박스 (작음, ~200px)**
```
[○ known] [◐ unsure] [● unknown]      ← 3개 상태 토글 버튼
[ 🔍 사전 ]
```

**문장 박스 (큼, ~360px)** — plan.txt 6줄 "단어 호버 박스보다 조금 더 커야 함"
```
원문 문장 (작은 글씨, 회색)
──────────────
[ 번역하기 ]
번역 결과 (또는 자동 번역)
──────────────
[이 문장의 단어 3개 → ○ ◐ ● 로 일괄 표시]
```

### 5.4 단어 vs 문장 선택 판별

네이티브 `Selection`을 그대로 쓰되 컨테이너 내부에서만 판정한다.

```ts
function handleSelection() {
  const sel = window.getSelection();
  if (!sel || !containerRef.current?.contains(sel.anchorNode)) return close();

  if (sel.isCollapsed) {
    // 단어 클릭 → 앵커 offset에서 segment 탐색 (이진 탐색)
    openWordPopover(segmentAt(offsetOf(sel.anchorNode, sel.anchorOffset)));
  } else {
    // 드래그 선택 → 오프셋 범위를 문장 경계로 확장
    const { start, end } = offsetsOf(sel);
    openSentencePopover(sentencesCovering(start, end));
  }
}
```

**모바일 대응** (앱 출시 목표이므로 필수): 모바일은 드래그 선택이 브라우저 UI와 충돌한다.
- 단어: 롱프레스(500ms) → 단어 박스
- 문장: 문장 첫 줄 앞에 `¶` 버튼을 항상 표시 → 탭 → 문장 박스

### 5.5 페이지 구분 (`lib/paginate.ts`)

plan.txt 7줄. 글자 수 기반 균등 분할.
1. 문장 경계 배열을 순회하며 목표 글자 수(기본 1800자, 사용자 설정 가능)를 넘으면 페이지 경계
2. 문장이 너무 길면(>600자) 문장 내부에서 단어 경계로 재분할
3. 페이지 탐색 UI: `‹ 2 / 7 ›` + 페이지별 요약(단어 수)

### 5.6 상태 바 (`StatusBar`)

문서 내 토큰을 순회하며 1회 계산, 상태 변경 시 해당 토큰만 부분 갱신.
```
단어 412  ·  ○ 아는 180  ·  ◐ 잘 모름 145  ·  ● 모름 87     [ 페이지 2/7 ]
```

### 5.7 색상 토큰 (`lib/color.ts`)

| 상태 | 아이콘 | 텍스트 | 밑줄 | 배경 |
|---|---|---|---|---|
| known | ○ | 기본(검정) | 없음 | 없음 |
| unsure | ◐ | amber-600 | 점선 | transparent |
| unknown | ● | red-600 | 실선 | red-50 |

plan.txt 4줄 "아는 단어는 기본 색(검은색)" 유지. 다크모드 대응 위해 CSS 변수로 분리.

---

## 6. API 설계 (Edge Functions)

### `POST /functions/v1/translate`
```jsonc
// req
{ "sourceLanguage": "ja", "targetLanguage": "en", "text": "..." }
// resp
{ "translatedText": "...", "cached": true }
```
처리: 캐시 조회(md5) → 히트 시 반환, 미스면 Google 호출 → 캐시 저장.

### `POST /functions/v1/dictionary`
```jsonc
// req
{ "languageCode": "ko", "lemma": "속다" }
// resp
{ "found": true,
  "phonetics": ["[sʰo̞k̚t͈a̠]"],
  "parts": [{ "partOfSpeech": "verb",
              "senses": [{ "definition": "to be cheated, to be deceived",
                           "tags": [], "examples": ["사기꾼이 하는 말에 속다."] }] }],
  "source": { "url": "https://en.wiktionary.org/wiki/속다", "license": "CC BY-SA 4.0" } }
```
처리 순서:
1. `dictionary_entries` 캐시 확인 (음답도 캐시해 upstream 재호출 방지)
2. freedictionaryapi.com 호출 — 영어 위키낱말 기반이라 **비영어 단어도 영어 뜻**으로 온다
3. 필요한 필드만 남겨 정규화 (quotes·synonyms는 저장하지 않는다)
4. 캐시 저장

**출처 표기**: 데이터는 CC BY-SA 4.0 이므로 사전 팝오버에 출처를 반드시 표시한다 (§8-1 참조).

---

## 7. 단계별 구현 순서

각 단계는 **동작 가능한 데모**가 끝나야 다음으로 간다.

### Phase 0 — 스캐폴딩 (0.5일)
- Vite + React + TS + Tailwind + PWA 플러그인
- Supabase 프로젝트 연결, 마이그레이션 1회 적용
- 디렉터리 구조 생성
- 산출물: 빈 앱 부팅 + PWA 설치 가능

### Phase 1 — 언어 선택 + 문서 열람 (1일)
- `SUPPORTED_LANGUAGES` 화이트리스트 (en, ja, ko, es, fr, de, zh, pt 등 8개 — plan.txt 5줄 "복잡하므로 배우고 싶은 것만")
- 온보딩: 언어 1개 이상 선택 → `user_languages` 저장
- 메인 화면: 언어 선택 → 텍스트 입력 → 문서 생성
- **로컬** 저장소(IndexedDB)로 동작 확인. Supabase 연동은 Phase 6
- 산출물: 글 넣으면 단어 단위로 렌더링됨

### Phase 2 — 단어 상태 + 색상 (1.5일)
- 토크나이저 구현 + 검증 fixture (영어, 일본어, 한국어)
- 단어 클릭 → `WordPopover`
- ○◐● 토글, 즉시 색상 반영 (낙관적 UI)
- 상태를 IndexedDB에 저장, 재접속 시 복원
- 산출물: plan.txt 3·4줄 충족

### Phase 3 — 문장 선택 + 번역 (1.5일)
- 문장 경계 계산 + 드래그 선택 판별
- `SentencePopover` (플래너보다 넓은 박스)
- `translate` Edge Function 구현 + 캐시
- 모바일 `¶` 버튼 폴백
- 산출물: plan.txt 6줄 충족

### Phase 4 — 사전 팝오버 (1.5일)
- `dictionary` Edge Function + 어댑터(Google / dictionaryapi.dev 분기)
- 언어별 `dictionary_entries` 캐시
- 사전 팝오버 UI (발음 / 품사 / 뜻 / 예문)
- 영어 정의 강제 변환 파이프라인
- 산출물: plan.txt 3·5줄 충족

### Phase 5 — 단어장 (1.5일) — **완료**
- 단어장 메인: 언어 선택 → 상태별 목록 (명세 3상태 + `미표시` 1탭)
- 각 항목: 원형, 첫 등장 예문, 출처 문서, 상태 변경
- 문서 내 단어장 진입 버튼 → 현재 문서 단어만 필터
- 검색, 언어별 등장 기록 지연 로딩
- 대소문자 판정 규칙(`surfaceLemma.ts`):
  1. 문장 중간에도 나온 대문자 표기 → 대소문자 유지 (고유명사)
  2. 문장 첫머리에만 나온 대문자 + 소문자 짝 → 소문자와 병합 (`The`/`the`)
  3. 구별을 증명할 수 없으면 접는다 — 문서를 넘나들며 상태가 쪼개지는 것보다 나쁘지 않음.
     사전 조회는 표기를 따로 보내므로 대소문자가 없어도 정확히 동작한다.
- 산출물: plan.txt 9줄 충족
- 검증: 단위 108건, e2e 101건 통과 (`e2e/specs/08-wordbook.spec.mjs`)

### Phase 6 — 계정 + 클라우드 동기화 (1.5일) — **완료 (경로 검증 제외)**
- Supabase Auth (이메일 매직링크 / Google 로그인) — `src/app/stores/auth.ts`
  - 로그인하지 않아도 앱을 완전히 쓸 수 있다. 계정은 학습을 이어가는 수단이지 전제 조건이 아니다
- RLS — 스키마에 이미 정책이 있고, `npm run verify:rls` 로 실측 검증한다
  - anon 키로 사용자 테이블 4종에서 0행, 쓰기 401, 조작한 jwt 로도 0행
  - 공유 캐시(번역·사전) 읽기는 열려 있어야 한다 — 막으면 사전이 죽는다
- 병합 (`src/lib/sync/merge.ts`) — `last_seen_at` 최신 + `status` 사용자 우선
  - `seen_count` 는 큰 값(합치면 매 동기화마다 숫자가 불어난다)
  - **반복해도 결과가 같아야 한다** (idempotent). 깨지면 동기화가 조용히 상태를 망가뜨린다
- 동기화 사이클 (`src/lib/sync/sync.ts`) — pull → merge → push
  - push 를 먼저 하면 이 기기의 옛 상태로 서버를 덮어써 다른 기기 작업을 잃는다
  - 문서 삭제는 서버에도 알린다 — 안 하면 다음 동기화에 다시 나타난다
- **산출물: plan.txt 1줄 충족** — 기기 바뀌어도 학습 이어짐
- 검증: 단위 185건, e2e 188건, RLS 실측 통과
- **미검증 경로**: 실제 로그인 → 기기 2대에서 서로 보이는지.
  메일함과 실제 계정이 있어야 하므로 자동 검증하지 않았다.
  직접 확인할 때: 브라우저 프로필 2개로 같은 계정 로그인 → 기기 A 에서 문서·단어 상태
  만들기 → 기기 B 에서 동기화 → 두 기기에서 모두 보이는지, 기기 A 에서 바꾼 상태가
  기기 B 에 반영되는지, 기기 A 에서 문서를 지운 것이 기기 B 에서 사라지는지.

### Phase 7 — 페이지 구분 + 상태 바 (1일) — **완료**
- `src/lib/paginate.ts` + `Pagination` 컴포넌트
  - 단어장: 한 쪽에 10·20·30·40·50 개 선택, 기본 20, 목록 위에서 고르고 설정에 남는다
  - 목록이 줄면 범위를 벗어난 쪽을 자동으로 당긴다 (빈 쪽을 보여주지 않음)
  - 쪽 수는 고르는 곳(언어·상태 탭·검색어·쪽 수 변경)에서 함께 초기화
- `src/features/reader/pageBreak.ts` — 문서 본문 페이지 구분 (plan.txt 7줄)
  - **문장 경계에서만** 자른다. 쪽은 원문 문자 범위를 빈틈없이 덮고,
    오프셋은 원문 그대로라 어느 쪽에서 눌러도 상태·문장 번역이 맞는다
  - 한 쪽 50·100·200·300·500 단어 (기본 100). 목표치이므로 문장 경계에서 끊어
    100 을 못 채우는 쪽이 나올 수 있다
- `StatusBar` — 하단 고정 상태 바 (plan.txt 8줄)
  - 총 단어 수(중복 제외) + 상태별 4분류 개수 + 표시 진행률 + 총 등장 횟수
  - 총합과 상태별 개수는 같은 기준(서로 다른 단어 수)으로 센다
- 산출물: plan.txt 7·8줄 충족
- 검증: 단위 156건, e2e 175건 통과 (`e2e/specs/11-reader-pages.spec.mjs`)
- 산출물: plan.txt 7·8줄 충족

### Phase 8 — PWA 완성 + 모바일 패키징 준비 (1일)
- Service worker, 오프라인 셸 캐시 — 셸은 이미 오프라인에서 열린다 (e2e 13 로 확인)
- 번역·사전 응답의 기기 사본 — **완료**
  - 서버 캐시가 있어도 보려면 서버에 닿아야 한다. 지하철에서 읽으려면 이 기기에도 남겨야 한다
  - **네트워크 실패일 때만** 사본을 쓴다. 서버가 "그런 단어 없다" 고 한 것을
    오프라인 탓으로 바꾸면 없는 단어가 있는 것처럼 보이는 훨씬 나쁜 오류가 된다
  - 사본으로 대신한 결과는 화면에 밝힌다 — 최신이라고 착각하지 않도록
  - 90일 지난 항목은 앱 시작 시 버린다
- 모바일 레이아웃 (safe-area, 반응형)
- Capacitor 설정 파일 + 앱 아이콘/스플래시 → 앱스토어 제출 시 남은 일 정리
- 산출물: plan.txt 1줄 완전 충족

**총 예상: 11일** (1인 기준, API 연동·토크나이저 검증에서 변동 가능)

---

## 8. 리스크 / 스펙 확정 필요 항목

| # | 항목 | 영향 | 대응 |
|---|---|---|---|
| 1 | ~~**사전 정의 영어 변환 품질**~~ **해소됨** | — | 실측 결론: Google Cloud Dictionary API 는 v3 에 존재하지 않는다(discovery revision 20260901, dictionary 메서드 0). freedictionaryapi.com 은 영어 위키낱말 기반이라 비영어도 영어 정의가 온다. 번역 파이프라인 불필요 |
| 1b | 위키낱말 커버리지 공백 | 사전 기능 일부 | 실측에서 `zh/猫`·`ja/曇り` 은 결과 없음. "찾지 못함" UI 를 준비하고 음답도 캐시한다 |
| 1c | 출처 라이선스 | 법적 compliance | CC BY-SA 4.0 — 팝오버에 위키낱말 출처를 명시한다 |
| 2 | Google Cloud API 과금 | 운영비 | 번역만 사용 (사전은 무료). 캐시로 반복 호출 0 |
| 3 | CJK 분절 정확도 | 일본어/중국어 학습 경험 | `Intl.Segmenter` + 폴백. MeCab 등 외부 사전은 후순위 |
| 4 | ~~모바일 텍스트 선택 충돌~~ **해소됨** | — | **터치 이벤트를 기다려서는 안 된다.** touchend·touchcancel 어느 쪽을 기다려도 `getSelection()` 은 아직 확정되지 않은 값을 준다 — 폰에서는 운영체제 기본 선택 상자만 뜨고 아무 일도 일어나지 않았다. 신호는 **`selectionchange`** 다 — 브라우저가 선택을 확정했다는 것을 직접 알려 준다. 게다가 손으로 끌면 선택이 컨테이너 밖까지 뻗어 `commonAncestorContainer` 검사도 놓친다. **드래그 없는 길**(단어 팝오버의 "이 문장 번역")은 그대로 둔다 |
| 5 | lemma 정규화(활용어) | 상태가 단어별로 안 모일 수 있음 | 기본 규칙 우선, 오탐 시 "표기 그대로" 옵션 추가 |
| 6 | Supabase RLS 실수 | 개인정보 유출 | Phase 6에서 정책 테스트 케이스 작성 필수 |

---

## 9. 미결정 (기본값 제안과 함께)

1. **정의 언어 고정**: plan.txt는 "영어로". 영어 학습자는 영어 정의가 의미 없으니 → 영어 학습 시엔 **영어 정의 + 한국어/영어 예문** 표기 제안. 기본은 영어 유지. -> 사용자가 자기 언어를 선택할 수 있게 함. 
2. **배울 언어 화이트리스트**: 8개 제안(en/ja/ko/es/fr/de/zh/pt). 더 필요하면 확장. -> 일단 이 정도로 충분함. 
3. **한국어 학습 지원**: 한국어 Service(한국어 성분/어미) 여부. v1은 번역+사전만, v2 고려. -> 일단 v1으로.
4. **오프라인 동작 범위**: 캐시된 번역/사전만 오프라인 읽기 가능한지, 완전히 오프라인 번역이 필요한지. -> 캐시된 번역/사전만
5. **앱스토어 목표**: Capacitor(iOS/Android) 제출까지 포함할지, PWA만으로 충분한지. -> 일단 pwa 만으로.

---

## 10. 배포 (nginx + Cloudflare)

`achijaser.date` 로 이 컴퓨터를 서빙한다. 웹서버는 nginx 이고,
Node(Express, PM2)는 개인 페이지 백엔드일 뿐이다.

### 10.0 DNS (Cloudflare)

| 이름 | 타입 | 프록시 | 용도 |
|---|---|---|---|
| `@` | A | Proxied | 개인 페이지 |
| `app` | A | Proxied | Lexi 앱 |
| `mc` | A | **DNS only** | 마크 서버 — 프록시하면 TCP 25565 가 막힌다 |
| `send` | — | DNS only | 메일 발신 (Resend) |

`mc` 가 DNS only 라서 원본 IP 가 노출된다. 표의 경고는 이 때문이다.
마크를 같은 IP 에 두는 한 완전히 막을 수 없다.

### 10.0.1 인증서

- **엣지**: Cloudflare 와일드카드 인증서가 이미 있다 (`*.achijaser.date`)
- **원본**: Cloudflare Origin CA 인증서 (ECC). SSL 모드는 **Full (strict)**

  Cloudflare → SSL/TLS → Origin Server → Create Certificate
  → `achijaser.date, *.achijaser.date` → 다운로드 후
  ```bash
  sudo install -m 644 cloudflare-origin.crt /etc/ssl/certs/achijaser-origin.pem
  sudo install -m 600 cloudflare-origin.key /etc/ssl/private/achijaser-origin.key
  ```

  개인 키는 world-readable 이면 nginx 가 기동을 거부한다.

### 10.0.2 nginx

`/etc/nginx/sites-available/lexi` — `/settings` 가 200 이어야 로그인이 된다.
매직링크가 항상 `origin + /settings` 로 돌아오는데 SPA fallback (`try_files`)
이 없으면 404 가 되고, 토큰을 소비할 페이지가 없어 로그인이 안 된 것처럼 보인다.

```nginx
server {
    listen 443 ssl;
    server_name app.achijaser.date;
    ssl_certificate     /etc/ssl/certs/achijaser-origin.pem;
    ssl_certificate_key /etc/ssl/private/achijaser-origin.key;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    root /var/www/lexi;
    index index.html;

    location = /index.html { add_header Cache-Control "no-cache"; }
    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    location / { try_files $uri $uri/ /index.html; }   # ← 이것 없으면 매직링크가 깨진다
}
```

### 10.0.3 갱신

```bash
npm run build
sudo cp -r dist/* /var/www/lexi/
sudo chown -R www-data:www-data /var/www/lexi
```

### 10.0.4 세션은 origin 에 묶인다

`218.155.107.116:5173` 과 `app.achijaser.date` 는 같은 서버라도 브라우저상
다른 사이트다. 거기서 로그인한 것과 여기서 로그인한 것은 서로 다른 계정이다.
검증도 배포 주소로 통일해 한다.

---

## 11. 로그인 수단 설정 (배포 전에 반드시)

코드는 다 들어 있다. 남은 것은 **Supabase 콘솔과 외부 서비스의 설정**뿐이고,
이건 계정 주인이 직접 해야 하는 일이다.

### 10.1 매직링크 (커스텀 SMTP) — 먼저 이것부터

Supabase 기본 메일 서버는 시간당 발송 횟수 제한이 크고 팀 멤버 주소로만 나간다.
실제 사용자 주소로는 메일이 가지 않으므로 그대로 두면 로그인이 영영 안 된다.

1. **Resend 계정** (resend.com) — 무료 티어 월 3,000통. 초기 사용자 전부 충분.
2. Resend → Domains → Add Domain 에 발신자 도메인을 넣는다.
   - **서브도메인을 쓰면 루트를 앱 호스팅에 남길 수 있다.**
   - 이 프로젝트의 선택: **`send.achijaser.date`**
   - Resend 가 사용자에게 발송 확인을 요구할 수 있다(자신에게 한 통 보내기).
     내 계정의 메일 주소를 입력하면 되고, 거절해도 발송 자체는 가능하다.
3. Resend 가 알려 주는 레코드를 Cloudflare DNS 에 그대로 넣는다.
   - 표준적으로 세 건이다: SPF(TXT) · DKIM(CNAME `resend._domainkey.…`) · MX
   - 리전에 따라 값이 달라지므로 Resend 화면의 값을 그대로 복사한다.
   - 넣었는지 확인하려면: `npm run verify:email -- send.achijaser.date`
4. Resend 화면의 상태가 `Verified` 가 될 때까지 기다린다. 몇 분~몇십 분 걸린다.
5. Resend → API Keys → **Sending access** 용 `re_...` 키 생성.
6. **Supabase** → Project Settings → Authentication → **Email**
   - Enable Email Provider: 켬
   - SMTP Host: `smtp.resend.com`
   - SMTP Port: `465` (587 을 쓰면 Enable TLS 를 켠다)
   - SMTP User: `resend`
   - SMTP Password: 위의 `re_...` 키
7. **Supabase** → Authentication → URL Configuration
   - Site URL: 앱 주소 (예: `https://achijaser.date`)
   - **Redirect URLs** 에 다음을 **직접 추가한다** — 안 넣으면 메일은 와도
     링크를 눌렀을 때 "redirect URL not allowed" 로 떨어진다.
     ```
     http://localhost:5173/settings     ← 로컬 개발용 (기본 허용됨)
     https://<앱 주소>/settings
     ```
8. 로그인 화면에서 링크 받기를 눌러 메일이 오는지 확인한다.
   **딱 한 번만 누른다** — 기본 서버든 커스텀 SMTP 든 시간당 발송량 제한이 있다.

로그인 링크가 열리면 `/settings` 로 돌아온다 (`auth.ts` 의 `emailRedirectTo`).

**네이버 등, 메일함은 외부 발신 메일을 조용히 버리는 경우가 실제로 있다.**
발송은 성공하는데 안 도착하면 그 사이일 수 있다. 도착 여부를 확인할 때는
Gmail 같은 주소로 먼저 시험한다.

### 10.2 Google 로그인 — 필요할 때만

1. **Google Cloud Console** → 프로젝트 생성 또는 선택 → APIs & Services → Credentials
2. OAuth consent screen 설정
   - 앱 이름·사용자 지원 이메일·개발자 연락처 이메일을 채운다.
   - 범위는 기본값(`email`, `profile`)이면 충분하다. 민감한 권한은 쓰지 않는다.
3. Credentials → OAuth client ID → **Web application**
   - Authorized redirect URIs 에 Supabase 의 콜백을 넣는다:
     `https://<project-ref>.supabase.co/auth/v1/callback`
4. 생성된 **Client ID / Client secret** 을 Supabase → Authentication → Providers → Google 에 붙인다.
5. 앱 배포 후 `.env.local` / 배포 환경에 `VITE_SHOW_GOOGLE_LOGIN=1` 을 넣는다.

**주의 — consent screen 이 "테스트" 상태인 동안에는 테스트 사용자로 등록한
계정만 로그인된다.** 실제 사용자를 받으려면 동의 화면을 게시 상태로 올려야 하고
검수 대기 시간이 붙는다. 그래서 매직링크를 먼저 켜는 쪽이 빠르다.

`VITE_SHOW_GOOGLE_LOGIN` 을 1 로 두기 전까지 버튼은 화면에 나타나지 않는다
(`src/lib/flags.ts`). 설정 전 배포에서 누가 눌렀을 때 실패하는 것을 막기 위함이다.

### 10.3 확인해 볼 것

```bash
npm run verify:rls   # anon 으로 다른 사용자 데이터가 안 보이는지
npm run e2e          # 로그인 없이도 앱이 전부 도는지
```

실제 동기화 경로는 자동 검증하지 않는다. 메일함과 계정이 있어야 하기 때문이다.
브라우저 프로필 2개(또는 PC + 폰)로 같은 계정 로그인 후 아래를 직접 확인한다.

- [ ] 기기 A 에서 문서와 단어 상태를 만들고 동기화
- [ ] 기기 B 에서 동기화 → A 의 문서와 상태가 모두 보이는가
- [ ] 기기 B 에서 상태를 바꾸고 동기화 → 기기 A 에 반영되는가
- [ ] 양쪽 시간을 바꿔 최근 조작이 이기는가 (`last_seen_at` 규칙)
- [ ] 기기 A 에서 문서를 지우고 동기화 → 기기 B 에서 사라지는가
