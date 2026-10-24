import type { WordStatus } from '../../types'

/**
 * 퀴즈에 낼 단어 한 개.
 *
 * lemma 는 상태·사전 조회의 열쇠, surface 는 화면에 보여 줄 표기다.
 * 둘을 나누는 이유는 문서에서와 같다 — US 와 us 는 다른 표기지만 다른 단어다.
 */
export type QuizWord = {
  lemma: string
  surface: string
  status: WordStatus
  /** 답한 뒤 보여 줄 문맥 예문 — 이번 세션에 고른 것 */
  sentence: string
  /** 그 예문이 나온 문서 제목 — 어디서 온 문맥인지 밝힌다 */
  documentTitle: string
  /** 이 단어가 나온 문장 전부 — 세션마다 다른 문맥을 골라 쓴다 */
  contexts?: QuizContext[]
  /** 마지막으로 본 시각 (ISO) — 간격 복습의 기한을 계산한다 */
  lastSeenAt?: string
  /** 앎 단추를 누른 횟수 — 앎 단어의 복습 간격을 늘린다 */
  knownPresses?: number
}

export type QuizContext = {
  sentence: string
  documentTitle: string
}

/** 하루 — 복습 간격의 단위 */
export const DAY_MS = 24 * 60 * 60 * 1000

/** 한 세션에서 앎 복습이 차지할 수 있는 몫 — 다른 재료가 남아 있는 동안 */
export const KNOWN_REVIEW_SHARE = 0.2

/**
 * 상태 전이표.
 *
 * 표의 나머지 칸은 누른 그대로가 된다 — 다만 '모름' 인 단어가 곧바로 '앎' 이
 * 되는 길은 막혀 있다. 처음 보는 단어를 한 번에 안다고 할 수는 없으므로,
 * 그 때는 '헷갈림' 에 머문다. 이 한 칸이 표를 표이게 하는 규칙이다.
 */
export function nextStatus(prev: WordStatus, pressed: WordStatus): WordStatus {
  if (prev === 'unknown' && pressed === 'known') return 'unsure'
  return pressed
}

/**
 * 고를 수 있는 세션 크기 — 10, 20, … 100.
 *
 * 가진 단어보다 많이 낼 수는 없다. 10 에도 못 미치면 가진 만큼이 유일한 선택지다.
 */
export function sessionSizeOptions(poolSize: number): number[] {
  const steps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  const sizes = steps.filter((size) => size <= poolSize)
  if (sizes.length > 0) return sizes
  return poolSize > 0 ? [poolSize] : []
}

/**
 * 처음 고르기 전 기본 개수 — 50.
 *
 * 너무 적으면(10) 진도가 잘 보이지 않고 너무 많으면(100) 지루해지므로 50 을
 * 기본으로 둔다. 가진 단어가 50 미만이면 50 을 고를 수 없으니 그 안에서 가장
 * 큰 선택지를 쓴다. 낼 단어가 아예 없으면 null 이다.
 */
export function defaultSessionSize(sizeOptions: number[]): number | null {
  if (sizeOptions.includes(50)) return 50
  return sizeOptions[sizeOptions.length - 1] ?? null
}

/** 상태를 판정하는 데 필요한 최소 모양 — 단어장 항목(WordbookEntry)이 그대로 만족한다 */
type StatusEntry = {
  lemma: string
  surfaces: string[]
  status: WordStatus | 'unmarked'
  /** 이 단어가 나온 문장 — 답한 뒤 보여 준다 */
  sentence: string
  /** 그 문장이 있는 문서 제목 */
  documentTitle: string
  /** 그 단어가 나온 문장들 — 퀴즈가 골라 쓴다 */
  contexts?: QuizContext[]
  /** 마지막으로 본 시각 — 간격 복습 */
  lastSeenAt?: string
  /** 앎 단추를 누른 횟수 — 앎 복습 간격 */
  knownPresses?: number
}

/** 단어장 항목 → 퀴즈 단어. 두 풀(헷갈림·모름 / 앎 복습)이 같은 모양을 쓴다 */
function toQuizWord(entry: StatusEntry): QuizWord {
  return {
    lemma: entry.lemma,
    surface: entry.surfaces[0] ?? entry.lemma,
    status: entry.status as WordStatus,
    sentence: entry.sentence,
    documentTitle: entry.documentTitle,
    contexts: entry.contexts,
    lastSeenAt: entry.lastSeenAt,
    knownPresses: entry.knownPresses,
  }
}

/**
 * 퀴즈에 낼 단어 — 아직 확실하지 않은 것만.
 *
 * '앎' 은 다시 물을 필요가 없고, '미표시' 는 아직 만나지도 않은 단어라
 * 여기서는 다루지 않는다. '헷갈림' 과 '모름' 이 이 퀴즈의 재료다.
 * 앎 단어는 기한이 되면 reviewPool 로 따로 들어온다.
 */
export function quizPool(entries: StatusEntry[]): QuizWord[] {
  return entries
    .filter((e) => e.status === 'unsure' || e.status === 'unknown')
    .map(toQuizWord)
}

/**
 * 이 상태의 복습 간격 (ms).
 *
 * 모름은 내일, 헷갈림은 사흘 뒤, 앎은 일주일 뒤에 다시 만난다. 앎을 세 번
 * 이상 누른 단어는 21일로 벌린다 — 굳은 단어를 자주 꺼내면 다른 단어를 볼
 * 시간을 빼앗을 뿐이다.
 */
export function reviewIntervalMs(status: WordStatus, knownPresses = 0): number {
  if (status === 'unknown') return 1 * DAY_MS
  if (status === 'unsure') return 3 * DAY_MS
  return (knownPresses >= 3 ? 21 : 7) * DAY_MS
}

/**
 * 이제 다시 볼 때인가.
 *
 * 마지막으로 본 시각이 없거나 해석할 수 없으면 true 다 — 건너뛰는 쪽보다
 * 한 번 더 보는 쪽이 낫다.
 */
export function isDue(
  state: { status: WordStatus; lastSeenAt?: string; knownPresses?: number },
  now: number,
): boolean {
  const last = state.lastSeenAt ? Date.parse(state.lastSeenAt) : Number.NaN
  if (Number.isNaN(last)) return true
  return now - last >= reviewIntervalMs(state.status, state.knownPresses ?? 0)
}

/** 기한이 된 앎 단어 — 간격 복습 재료. now 를 생략하면 지금 시각 */
export function reviewPool(entries: StatusEntry[], now: number = Date.now()): QuizWord[] {
  return entries
    .filter((e) => e.status === 'known' && isDue(
      { status: 'known', lastSeenAt: e.lastSeenAt, knownPresses: e.knownPresses },
      now,
    ))
    .map(toQuizWord)
}

/** 겹치지 않게 섞는다 — 원래 목록은 건드리지 않는다 */
function shuffled<T>(items: T[], rng: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.min(Math.floor(rng() * (i + 1)), i)
    const swap = copy[i]
    copy[i] = copy[j]
    copy[j] = swap
  }
  return copy
}

/** 이번 세션에 보여 줄 문맥 하나를 고른다 — 없으면 원래 예문 그대로 */
function withContext(word: QuizWord, rng: () => number): QuizWord {
  const contexts =
    word.contexts && word.contexts.length > 0
      ? word.contexts
      : [{ sentence: word.sentence, documentTitle: word.documentTitle }]
  const index = Math.min(Math.floor(rng() * contexts.length), contexts.length - 1)
  const context = contexts[index]
  return {
    ...word,
    sentence: context.sentence,
    documentTitle: context.documentTitle,
  }
}

/**
 * 겹치지 않게 count 개를 무작위로 뽑는다.
 *
 * 원래 목록은 건드리지 않는다 (같은 풀을 세션마다 다시 쓸 수 있어야 한다).
 * rng 를 받는 이유는 테스트에서 순서를 고정하기 위해서다. 뽑힌 단어마다
 * 문맥도 하나 골라 붙인다 — 같은 단어라도 세션마다 다른 문장에서 만난다.
 */
export function drawWords(
  pool: QuizWord[],
  count: number,
  rng: () => number = Math.random,
): QuizWord[] {
  const take = Math.min(Math.max(count, 0), pool.length)
  return shuffled(pool, rng)
    .slice(0, take)
    .map((word) => withContext(word, rng))
}

/**
 * 세션에 낼 단어를 고른다 — 헷갈림·모름과 앎 복습을 함께.
 *
 * 앎 복습은 세션의 20% 까지만 섞는다 (다른 재료가 남아 있는 동안). 낼 것이
 * 모자라면 남는 자리는 앎으로 채운다 — 빈 세션보다는 복습이 낫다. 마지막에
 * 다시 섞는 이유는 교차 연습이다: 같은 상태끼리 몰아 보면 구분이 약해진다.
 */
export function selectSession(
  pool: QuizWord[],
  reviews: QuizWord[],
  count: number,
  rng: () => number = Math.random,
): QuizWord[] {
  if (count <= 0) return []

  const known = shuffled(reviews, rng)
  const unsure = shuffled(pool, rng)
  const cap = Math.max(1, Math.floor(count * KNOWN_REVIEW_SHARE))
  const reviewTake = Math.min(cap, known.length, count)
  const poolTake = Math.min(count - reviewTake, unsure.length)

  const picked = [...unsure.slice(0, poolTake), ...known.slice(0, reviewTake)]

  // 자리가 남으면 헷갈림·모름으로 먼저 채우고, 그래도 남으면 앎으로 채운다
  const remainingAfterPool = count - picked.length
  if (remainingAfterPool > 0) {
    picked.push(...unsure.slice(poolTake, poolTake + remainingAfterPool))
  }
  const remainingAfterKnown = count - picked.length
  if (remainingAfterKnown > 0) {
    picked.push(...known.slice(reviewTake, reviewTake + remainingAfterKnown))
  }

  return shuffled(picked, rng).map((word) => withContext(word, rng))
}

/** 빈칸 표시 — 폭이 일정해야 문장이 흔들리지 않는다 */
const BLANK = '____'

/** 띄어쓰기 없이 붙여 쓰는 문자 — 이 안에서는 낱말 경계를 따질 수 없다 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * 예문에서 표기 하나를 빈칸으로 가린다 — 앎 단어의 생산 연습.
 *
 * 문장에 그 표기가 정확히 한 번 나올 때만 가린다. 두 번 나오면 어느 자리를
 * 가릴지 알 수 없고, 한 번도 없으면 이 문장으로는 낼 수 없다. null 을 주면
 * 호출하는 쪽이 기존 방식(단어를 보여 주고 뜻을 묻는)으로 되돌아간다.
 *
 * 띄어쓰기가 있는 언어는 낱말 경계를 지킨다 — 'cat' 이 'concatenate' 속에서
 * 걸리면 엉뚱한 자리를 가리게 된다. 일본어·중국어·한국어는 붙여 쓰므로
 * 표기 그대로 찾는다 (조사가 붙어도 가릴 수 있어야 한다).
 */
export function blankWord(sentence: string, surface: string): string | null {
  if (!sentence || !surface) return null

  if (CJK.test(surface)) {
    const parts = sentence.split(surface)
    if (parts.length !== 2) return null
    return `${parts[0]}${BLANK}${parts[1]}`
  }

  const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu')
  const matches = sentence.match(pattern)
  if (!matches || matches.length !== 1) return null
  return sentence.replace(pattern, BLANK)
}

/** 세션이 끝난 뒤의 상태별 개수 — 끝난 화면의 요약에 쓴다 */
export function summarize(statuses: WordStatus[]): Record<WordStatus, number> {
  const counts: Record<WordStatus, number> = { known: 0, unsure: 0, unknown: 0 }
  for (const status of statuses) counts[status] += 1
  return counts
}

/**
 * 답한 문제만 남긴다.
 *
 * Sessions advance in order, so the recorded answers form a prefix of the
 * selected words. Ending early must not make unanswered questions look like
 * they were part of the completed session.
 */
export function answeredSessionWords(
  words: readonly QuizWord[],
  results: readonly WordStatus[],
): QuizWord[] {
  return words.slice(0, Math.min(words.length, results.length))
}

/** 끝난 화면의 한 줄 — 단어 하나의 풀기 전과 후 */
export type SessionChange = {
  surface: string
  before: WordStatus
  after: WordStatus
  changed: boolean
}

/**
 * 단어별 변화 — 푼 순서 그대로.
 *
 * 세션을 시작할 때의 상태가 before, 답한 뒤가 after 다. 순서를 섞거나 바뀐 줄을
 * 따로 모으지 않는 것은 정한 것이다 — 푼 순서를 그대로 보여 주되 강조는 하지
 * 않는다. 답하지 못한 줄은 before 로 두어 변화 없는 줄이 되게 한다.
 */
export function sessionChanges(words: QuizWord[], results: WordStatus[]): SessionChange[] {
  return words.map((word, index) => {
    const before = word.status
    const after = results[index] ?? before
    return { surface: word.surface, before, after, changed: after !== before }
  })
}
