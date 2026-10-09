import type { LanguageCode, Segment, Sentence } from '../../types'
import { stripElision } from './elision'
import { getLanguage } from '../../lib/languages'

/**
 * 원문을 문장·단위로 분절한다 (PLAN.md §5.1).
 *
 * 핵심 규칙: 모든 오프셋은 원문 기준 유니코드 문자 인덱스다.
 * 세그먼트 배열은 원문 전체를 빈틈없이 덮으므로 그대로 렌더링해도 글자가 사라지지 않는다.
 */

const WORD_START_RE = /[\p{L}\p{N}]/u
const WORD_BODY_RE = /[\p{L}\p{M}\p{N}]/u

/** 글자 — 숫자는 단어가 되기에 모자라다 */
const HAS_LETTER_RE = /\p{L}/u

/** 어절을 이어붙이는 아포스트로피 — don't, it's 처럼 언제나 한 단어다. */
const APOSTROPHES = new Set(["'", '’', 'ʼ'])

/**
 * 이 문자 앞에서 새 문장자�� 대문자를 시작한다.
 *
 * 문장 안에서도 대문자를 강제하는 문자들이 있다 — 위치에서 온 대문자를 여기서 걸러 낸다.
 */
const CAPITALISES_AFTER = new Set([
  ':', ';', '!', '?',
  '(', '[', '{',
  '«', '“', '‘', '"', "'",
  '—', '–', '―',
])

/** 하이픈·대시 계열 */
const HYPHENS = new Set(['-', '‐', '‑', '‒', '–', '—', '―'])

const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？', '‼', '⁇', '⁈', '⁉'])

/** 라틴 종결자는 뒤에 공백이 있어야 문장으로 인정한다 (3.14 vs He left.) */
const SPACED_TERMINATORS = new Set(['.', '!', '?', '…'])

/** 종결어 뒤에 붙는 닫는 기호 — 문장에 포함시켜야 한다 ("Hello." → `"`까지) */
const TRAILING_CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»', '〕', '〉', '｝'])

/**
 * 약식 두문자. 종결어 뒤 공백이 있어도 문장이 안 끊어지도록 예외 처리한다.
 * 영문 텍스트 전제 — 다른 언어는 영향 없다.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'fig', 'no', 'vs', 'etc', 'eg', 'ie',
])

export function computeSentences(text: string): Sentence[] {
  const sentences: Sentence[] = []
  let cursor = 0

  const push = (start: number, end: number) => {
    if (end > start) sentences.push({ index: sentences.length, start, end, text: text.slice(start, end) })
  }

  while (cursor < text.length) {
    const boundary = findSentenceEnd(text, cursor)
    if (boundary === -1) break
    push(cursor, boundary)
    cursor = boundary
  }
  push(cursor, text.length)

  // 앞뒤 공백만 있는 조각은 버린다.
  // 이때 index 를 다시 매겨야 한다 — 빈 줄 때문에 밀린 index 를 그대로 두면
  // 나중에 sentences[word.sentenceIndex] 조회가 엉뚱한 문장을 가리킨다.
  return sentences
    .filter((s) => s.text.trim().length > 0)
    .map((s, index) => ({ ...s, index }))
}

/**
 * 이 위치의 대문자는 **위치에서 온 것인가.**
 *
 * 문장 첫머리의 대문자와 고유명사의 대문자는 눈으로 보면 같다. 구별하는 유일한
 * 무료 신호는 '같은 문서에 소문자 표기가 있는가' 다 — 그래서 '위치에서 온 대문자' 와
 * '문장 한가운데의 대문자' 를 나눌 수밖에 없다.
 *
 * 그런데 '문장 중간' 이라고 하면 사실이 좀 다르다. 문장 안에서도 대문자를 강제하는
 * 문자가 있다 — 콜론, 세미콜론, 여는 괄호, 여는 따옴표, 대시.
 *   Voici : Pour Understand.
 *   « Pour Understand » dit-il.
 * 이 `Pour` 는 첫 단어도 아니 고유명사도 아니다. 위치에서 온 대문자다.
 * 이걸 '문장 중간' 으로 세면 `Pour` 와 `pour` 가 갈라지고, 같은 말이 두 단어로 세어진다.
 *
 * 그래서 뒤로 거슬러 올라가 **대문자를 유발하는 문자** 를 찾는다. 그게 없으면 문장
 * 한가운데서 대문자 — 그것은 고유명사의 유일한 증거로 남긴다 (US, Paris, Apple).
 *
 * 문장 경계는 앞쪽 공백을 포함하므로 (예: " The us in …") 단순히 시작 오프셋을
 * 비교하면 안 된다 — 그 사이에 공백만 있는지 확인해야 한다.
 */
export function isCapitalisedPosition(
  text: string,
  sentences: Sentence[],
  wordStart: number,
  sentenceIndex: number,
): boolean {
  const sentence = sentences.find((s) => s.index === sentenceIndex)
  if (!sentence) return false

  // 뒤로 공백을 건너뛴다
  let at = wordStart - 1
  while (at >= sentence.start && /\s/u.test(text[at] ?? '')) at--

  if (at < sentence.start) return true

  // 문장 경계는 앞쪽 공백을 포함하므로, 여기까지 왔다면 첫 단어다
  if (at + 1 <= sentence.start) return true

  return CAPITALISES_AFTER.has(text[at])
}

function findSentenceEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') return skipBlankLines(text, i)

    if (!SENTENCE_TERMINATORS.has(ch)) continue

    // 닫는 기호는 종결어 뒤에 붙는 게 정상이다 — `stop."` 를 끊어야 한다
    let end = i + 1
    while (end < text.length && TRAILING_CLOSERS.has(text[end])) end++

    // 그 다음이 공백이 아니면 종결이 아니다 (3.14, U.S.A, stop.Next)
    // CJK 종결자는 뒤 공백 없이도 문장이 끝난다
    if (SPACED_TERMINATORS.has(ch)) {
      const next = text[end]
      if (next !== undefined && !/\s/.test(next)) continue
    }

    const prev = text[i - 1]
    if (ch === '.' && prev !== undefined && /[\p{L}\p{N}]/u.test(prev)) {
      const abbr = text.slice(from, i).match(/(?:^|[\s(])([\p{L}.]+)$/u)?.[1]?.toLowerCase()
      if (abbr && ABBREVIATIONS.has(abbr)) continue
    }

    return end
  }
  return -1
}

function skipBlankLines(text: string, at: number): number {
  let end = at
  while (end < text.length && /\s/.test(text[end])) end++
  return end
}

/** 단어 구간 [start, end) 목록. 오름차순, 겹치지 않음. */
function wordRanges(text: string, languageCode: string): Array<[number, number]> {
  if (getLanguage(languageCode)?.cjk) {
    return mergeJoined(segmenterWordRanges(text, languageCode), text)
  }
  return regexWordRanges(text)
}

function regexWordRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0

  while (i < text.length) {
    if (!WORD_START_RE.test(text[i])) {
      i++
      continue
    }

    const start = i
    i++
    while (i < text.length) {
      const ch = text[i]
      if (WORD_BODY_RE.test(ch)) {
        i++
        continue
      }
      if (APOSTROPHES.has(ch) && startsWord(text, i + 1)) {
        i += 2
        continue
      }
      if (HYPHENS.has(ch) && joinsAcrossHyphen(text, i + 1)) {
        i += 2
        continue
      }
      break
    }
    out.push([start, i])
  }

  return out
}

/**
 * 하이픈은 양쪽이 이어질 때만 붙인다.
 * 뒤쪽이 대문자면 고유명사(Jean-Luc)이므로 끊고, 숫자면 단위(CCOVID-19)이므로 붙인다.
 * 대소문자를 가지지 않는 문자(한자·가나)는 붙인다.
 */
function joinsAcrossHyphen(text: string, at: number): boolean {
  const next = text[at]
  if (next === undefined) return false
  if (/\p{N}/u.test(next)) return true
  if (!WORD_START_RE.test(next)) return false
  // 소문자면 붙이고 대문자면 끊는다. 한자·가나는 대소문자가 없으므로 붙는다.
  return next === next.toLowerCase()
}

function startsWord(text: string, at: number): boolean {
  return at < text.length && WORD_START_RE.test(text[at])
}

/**
 * 공백 없는 언어(일본어·중국어)는 사전 분절이 필요하다.
 * Intl.Segmenter 미지원 브라우저에서는 한자/가나 단위로 폴백한다.
 */
function segmenterWordRanges(text: string, languageCode: string): Array<[number, number]> {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return [...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].flatMap((m) =>
      m.index === undefined ? [] : [[m.index, m.index + m[0].length] as [number, number]],
    )
  }
  const segmenter = new Intl.Segmenter(languageCode, { granularity: 'word' })
  const out: Array<[number, number]> = []
  for (const s of segmenter.segment(text)) {
    if (!s.isWordLike) continue
    out.push([s.index, s.index + s.segment.length])
  }
  return out
}

/** 어절 중간에서 끊긴 조각을 다시 잇는다 (Intl.Segmenter 경로에서 사용) */
function mergeJoined(ranges: Array<[number, number]>, text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const range of ranges) {
    const prev = out.at(-1)
    if (prev && range[0] === prev[1]) {
      const gap = text[range[0]]
      const joins = APOSTROPHES.has(gap)
        ? startsWord(text, range[0] + 1)
        : HYPHENS.has(gap) && joinsAcrossHyphen(text, range[0] + 1)
      if (joins) {
        prev[1] = range[1]
        continue
      }
    }
    out.push([...range] as [number, number])
  }
  return out
}

/**
 * 원형(lemma) 정규화.
 *
 * v1은 소문자 + 소유격 's 제거만 한다. 복수형(-s/-es/-ies) 접기는 정확한 사전이나
 * 언어 빈도 목록 없이는 오탐이 생긴다(예: was → wa). 학습 상태가 단어별로
 * 어긋나면 그때 사전 연동으로 교체한다 (PLAN.md §8-5).
 */
export function normalizeLemma(word: string, languageCode?: LanguageCode): string {
  /**
   * 축약을 **소문자로 내리기 전에** 푼다.
   *
   * 고유명사 판정은 아포스트로피 뒤의 대문자를 본다 — d'Artagnan 과 d'été 의 갈림길이
   * 그것이다. 먼저 소문자로 내리면 대문자가 사라져 이름까지 축약으로 접힌다.
   * 순서를 바꾸면 그 신호가 살아 있다.
   */
  let w = stripElision(word, languageCode) ?? word
  w = w.toLowerCase()

  const possessive = w.match(/^(.+?)['’]s$/)
  if (possessive && !/^(it|he|she|that's|what's|who's|let's)$/.test(possessive[1])) {
    w = possessive[1]
  }
  return w
}

export type TokenizeResult = { segments: Segment[]; sentences: Sentence[] }

export function tokenize(text: string, languageCode: LanguageCode): TokenizeResult {
  const sentences = computeSentences(text)
  const ranges = wordRanges(text, languageCode)

  const sentenceIndexAt = (offset: number): number => {
    const s = sentences.find((c) => offset >= c.start && offset < c.end)
    return s ? s.index : sentences.length - 1
  }

  const segments: Segment[] = []
  let cursor = 0

  for (const [start, end] of ranges) {
    if (start > cursor) {
      segments.push({ type: 'text', start: cursor, end: start, text: text.slice(cursor, start) })
    }
    const surface = text.slice(start, end)
    /**
     * 숫자만으로는 단어가 되지 않는다.
     *
     * 2026, 3.14 같은 것은 어휘가 아니라 클릭해도 상태·사전·단어장에 들 이유가
     * 없다. 글자가 하나라도 있어야 단어다 — 1st, COVID-19 같은 혼합은 단어로
     * 남는다. 유니코드 십진수(아라비아-인디 숫자 등)도 글자가 없으면 같다.
     */
    if (!HAS_LETTER_RE.test(surface)) {
      segments.push({ type: 'text', start, end, text: surface })
    } else {
      segments.push({
        type: 'word',
        start,
        end,
        text: surface,
        lemma: normalizeLemma(surface, languageCode),
        sentenceIndex: sentenceIndexAt(start),
      })
    }
    cursor = end
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', start: cursor, end: text.length, text: text.slice(cursor) })
  }

  return { segments, sentences }
}

/** 문자 오프셋를 포함하는 단어 세그먼트를 이분 탐색으로 찾는다. */
export function segmentAt(segments: Segment[], offset: number): Segment | undefined {
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]
    if (offset < s.start) hi = mid - 1
    else if (offset >= s.end) lo = mid + 1
    else return s.type === 'word' ? s : undefined
  }
  return undefined
}