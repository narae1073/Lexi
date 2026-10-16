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
  /** 답한 뒤 보여 줄 문맥 예문 — 단어장의 예문과 같은 것 */
  sentence: string
  /** 그 예문이 나온 문서 제목 — 어디서 온 문맥인지 밝힌다 */
  documentTitle: string
}

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
}

/**
 * 퀴즈에 낼 단어 — 아직 확실하지 않은 것만.
 *
 * '앎' 은 다시 물을 필요가 없고, '미표시' 는 아직 만나지도 않은 단어라
 * 여기서는 다루지 않는다. '헷갈림' 과 '모름' 이 이 퀴즈의 재료다.
 */
export function quizPool(entries: StatusEntry[]): QuizWord[] {
  return entries
    .filter((e) => e.status === 'unsure' || e.status === 'unknown')
    .map((e) => ({
      lemma: e.lemma,
      surface: e.surfaces[0] ?? e.lemma,
      status: e.status as WordStatus,
      sentence: e.sentence,
      documentTitle: e.documentTitle,
    }))
}

/**
 * 겹치지 않게 count 개를 무작위로 뽑는다.
 *
 * 원래 목록은 건드리지 않는다 (같은 풀을 세션마다 다시 쓸 수 있어야 한다).
 * rng 를 받는 이유는 테스트에서 순서를 고정하기 위해서다.
 */
export function drawWords(
  pool: QuizWord[],
  count: number,
  rng: () => number = Math.random,
): QuizWord[] {
  const copy = [...pool]
  const take = Math.min(Math.max(count, 0), copy.length)
  // Fisher–Yates — 앞에서부터 take 개를 치우고 그만큼만 취한다
  for (let i = 0; i < take; i++) {
    const span = copy.length - i
    const offset = Math.min(Math.floor(rng() * span), span - 1)
    const j = i + offset
    const swap = copy[i]
    copy[i] = copy[j]
    copy[j] = swap
  }
  return copy.slice(0, take)
}

/** 세션이 끝난 뒤의 상태별 개수 — 끝난 화면의 요약에 쓴다 */
export function summarize(statuses: WordStatus[]): Record<WordStatus, number> {
  const counts: Record<WordStatus, number> = { known: 0, unsure: 0, unknown: 0 }
  for (const status of statuses) counts[status] += 1
  return counts
}
