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

/** 공백·구두점이 없는 낱말인가 — 아니면 토큰 하나로 잡히지 않는다 */
const PLAIN_WORD = /^[\p{L}\p{N}]+$/u

/**
 * 문장 하나를 한 번만 훑어 색인을 만든다.
 *
 * 예전에는 단어마다 유니코드 경계 정규식을 새로 컴파일했다. 단어장이 4천 개만
 * 되어도 문제 하나에 몇 초가 걸렸다 — 이제 문장은 한 번만 훑고, 단어는 집합
 * 조회로 끝낸다.
 */
type SentenceIndex = {
  /** 원문 — CJK 는 붙여 쓰므로 부분 문자열로 본다 */
  raw: string
  lower: string
  /** 소문자 낱말 집합 */
  tokens: Set<string>
}

function indexSentence(sentence: string): SentenceIndex {
  const lower = sentence.toLowerCase()
  return {
    raw: sentence,
    lower,
    tokens: new Set(lower.match(/[\p{L}\p{N}]+/gu) ?? []),
  }
}

function appearsInIndex(index: SentenceIndex, form: string): boolean {
  if (!form) return false
  // 일본어·중국어·한국어는 붙여 쓰므로 조사가 붙어도 찾아야 한다
  if (CJK.test(form)) return index.raw.includes(form)
  // 공백·구두점이 든 표기(숙어, don't)는 토큰 하나로 잡히지 않는다
  if (!PLAIN_WORD.test(form)) return index.lower.includes(form.toLowerCase())
  return index.tokens.has(form.toLowerCase())
}

/**
 * 이 표기가 문장에 낱말로 나오는가.
 *
 * 오답으로 이미 문장에 있는 단어를 내면 빈칸 옆에 답이 또 있어 헷갈린다.
 * 낱말 경계를 지킨다 — 'at' 이 'sat' 속에서 걸리면 안 된다.
 */
export function appearsInSentence(sentence: string, form: string): boolean {
  return appearsInIndex(indexSentence(sentence), form)
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
 * 오답 후보 — 이번 세션 단어를 먼저, 모자라면 단어장 전체에서.
 *
 * 문장에 이미 나온 단어는 뺀다. 세션 단어만으로 두 개가 나오면 단어장 전체를
 * 훑지 않는다 — 예전에는 문제마다 단어장을 전부 정규식으로 검사해 몇 초가 걸렸다.
 * 순서는 섞고, 같은 표기는 한 번만 담는다.
 */
export function pickDistractors(
  entries: DistractorEntry[],
  targetLemma: string,
  sentence: string,
  options: {
    count: number
    /** 이번 세션에 뽑힌 단어들 — 단어장 전체보다 먼저 본다 */
    sessionEntries?: DistractorEntry[]
    rng?: () => number
  },
): QuizChoice[] {
  const { count, sessionEntries = [], rng = Math.random } = options
  if (count <= 0) return []

  const index = indexSentence(sentence)
  const picked: QuizChoice[] = []
  const seenLemmas = new Set([targetLemma])
  const seenLabels = new Set<string>()

  /** 넣었으면 true — 다 채웠으면 호출하는 쪽이 바로 끝낸다 */
  const add = (entry: DistractorEntry): boolean => {
    if (picked.length >= count) return true
    if (entry.lemma === targetLemma) return false
    const labelKey = entry.lemma.toLowerCase()
    if (seenLemmas.has(entry.lemma) || seenLabels.has(labelKey)) return false
    if (appearsInIndex(index, entry.lemma)) return false
    if (entry.surfaces.some((surface) => appearsInIndex(index, surface))) return false
    seenLemmas.add(entry.lemma)
    seenLabels.add(labelKey)
    picked.push({ lemma: entry.lemma, label: entry.lemma })
    return picked.length >= count
  }

  // 1) 이번 세션 단어 — 대부분 여기서 끝난다
  for (const entry of shuffled(sessionEntries, rng)) {
    if (add(entry)) return picked
  }

  // 2) 단어장 전체 — 표시한 단어를 먼저, 그다음 나머지
  const marked: DistractorEntry[] = []
  const rest: DistractorEntry[] = []
  for (const entry of entries) {
    if (seenLemmas.has(entry.lemma)) continue
    if (entry.status !== 'unmarked') marked.push(entry)
    else rest.push(entry)
  }
  for (const entry of [...shuffled(marked, rng), ...shuffled(rest, rng)]) {
    if (add(entry)) return picked
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
