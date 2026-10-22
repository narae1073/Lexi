import type { WordStatus } from '../../types'

/** 선택지 한 개 — 화면에 보일 표기와 비교에 쓸 lemma 를 나눈다 */
export type QuizChoice = {
  lemma: string
  /** 화면에 보여 줄 표기. 정답은 문장에서 가린 그대로다 */
  label: string
}

/** 오답 후보를 고르는 데 필요한 최소 모양 — 단어장 항목이 그대로 만족한다 */
export type DistractorEntry = {
  lemma: string
  surfaces: string[]
  status: WordStatus | 'unmarked'
}

/** 띄어쓰기 없이 붙여 쓰는 문자 — 이 안에서는 낱말 경계를 따질 수 없다 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 이 표기가 문장에 낱말로 나오는가.
 *
 * 오답으로 이미 문장에 있는 단어를 내면 빈칸 옆에 답이 또 있어 헷갈린다.
 * 띄어쓰기가 있는 언어는 낱말 경계를 지킨다 — 'at' 이 'sat' 속에서 걸리면 안 된다.
 */
export function appearsInSentence(sentence: string, form: string): boolean {
  if (!form) return false
  if (CJK.test(form)) return sentence.includes(form)
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(form)}(?![\\p{L}\\p{N}])`,
    'iu',
  )
  return pattern.test(sentence)
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

/**
 * 오답 후보 — 단어장의 다른 단어들.
 *
 * 문장에 이미 나온 단어는 뺀다. 이번 세션 단어 → 표시한 단어 → 나머지 순으로
 * 앞세운다: 방금 만난 얼굴이 섞여야 문제가 덜 낯설다. 순서는 섞고, 같은 표기는
 * 한 번만 담는다.
 */
export function pickDistractors(
  entries: DistractorEntry[],
  targetLemma: string,
  sentence: string,
  options: {
    count: number
    sessionLemmas?: ReadonlySet<string>
    rng?: () => number
  },
): QuizChoice[] {
  const { count, sessionLemmas = new Set<string>(), rng = Math.random } = options
  if (count <= 0) return []

  const candidates = entries.filter((entry) => {
    if (entry.lemma === targetLemma) return false
    if (appearsInSentence(sentence, entry.lemma)) return false
    return !entry.surfaces.some((surface) => appearsInSentence(sentence, surface))
  })

  const session: DistractorEntry[] = []
  const marked: DistractorEntry[] = []
  const rest: DistractorEntry[] = []
  for (const entry of candidates) {
    if (sessionLemmas.has(entry.lemma)) session.push(entry)
    else if (entry.status !== 'unmarked') marked.push(entry)
    else rest.push(entry)
  }

  const ordered = [
    ...shuffled(session, rng),
    ...shuffled(marked, rng),
    ...shuffled(rest, rng),
  ]

  const picked: QuizChoice[] = []
  const seenLemmas = new Set([targetLemma])
  const seenLabels = new Set<string>()
  for (const entry of ordered) {
    if (picked.length >= count) break
    const label = entry.lemma
    const labelKey = label.toLowerCase()
    if (seenLemmas.has(entry.lemma) || seenLabels.has(labelKey)) continue
    seenLemmas.add(entry.lemma)
    seenLabels.add(labelKey)
    picked.push({ lemma: entry.lemma, label })
  }
  return picked
}

/**
 * 정답 + 오답 선택지. 오답이 모자라면 null — 화면은 세 단추로 되돌아간다.
 *
 * 같은 표기(대소문자 무시)는 두 번 내지 않는다 — 'US' 와 'us' 가 한 문제에
 * 같이 나오면 어느 쪽이 답인지 알 수 없다.
 */
export function buildChoices(
  correct: QuizChoice,
  distractors: QuizChoice[],
  count = 2,
  rng: () => number = Math.random,
): QuizChoice[] | null {
  const seenLemmas = new Set([correct.lemma])
  const seenLabels = new Set([correct.label.toLowerCase()])
  const picked: QuizChoice[] = []

  for (const distractor of distractors) {
    if (picked.length >= count) break
    const labelKey = distractor.label.toLowerCase()
    if (seenLemmas.has(distractor.lemma) || seenLabels.has(labelKey)) continue
    seenLemmas.add(distractor.lemma)
    seenLabels.add(labelKey)
    picked.push(distractor)
  }

  if (picked.length < count) return null
  return shuffled([correct, ...picked], rng)
}
