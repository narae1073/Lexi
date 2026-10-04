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

### Phase 6 — 계정 + 클라우드 동기화 (1.5일)
- Supabase Auth (이메일 매직링크 / Google 로그인)
- 모든 테이블 RLS 적용
- 로컬 ↔ 서버 병합 (충돌: `last_seen_at` 최신 + `status` 사용자 우선)
- **산출물: plan.txt 1줄 충족** — 기기 바뀌어도 학습 이어짐

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
- Service worker, 오프라인 셸 캐시
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
| 4 | 모바일 텍스트 선택 충돌 | 모바일 UX | 롱프레스 + `¶` 버튼으로 별도 경로 확보 |
| 5 | lemma 정규화(활용어) | 상태가 단어별로 안 모일 수 있음 | 기본 규칙 우선, 오탐 시 "표기 그대로" 옵션 추가 |
| 6 | Supabase RLS 실수 | 개인정보 유출 | Phase 6에서 정책 테스트 케이스 작성 필수 |

---

## 9. 미결정 (기본값 제안과 함께)

1. **정의 언어 고정**: plan.txt는 "영어로". 영어 학습자는 영어 정의가 의미 없으니 → 영어 학습 시엔 **영어 정의 + 한국어/영어 예문** 표기 제안. 기본은 영어 유지. -> 사용자가 자기 언어를 선택할 수 있게 함. 
2. **배울 언어 화이트리스트**: 8개 제안(en/ja/ko/es/fr/de/zh/pt). 더 필요하면 확장. -> 일단 이 정도로 충분함. 
3. **한국어 학습 지원**: 한국어 Service(한국어 성분/어미) 여부. v1은 번역+사전만, v2 고려. -> 일단 v1으로.
4. **오프라인 동작 범위**: 캐시된 번역/사전만 오프라인 읽기 가능한지, 완전히 오프라인 번역이 필요한지. -> 캐시된 번역/사전만
5. **앱스토어 목표**: Capacitor(iOS/Android) 제출까지 포함할지, PWA만으로 충분한지. -> 일단 pwa 만으로.
