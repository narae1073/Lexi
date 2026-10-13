import type { LanguageCode } from '../types'

/**
 * 붙여넣은 글의 언어를 알아낸다 (개선사항.txt: 붙여넣기 탭의 언어 감지).
 *
 * 두 말을 섞지 않는다.
 *
 * **문자로 말하는 언어** — 가나(일본어), 한글(한국어), 한자(중국어)는 다른
 * 알파벳과 섞일 수 없다. 하나만 보여도 그 언어다. 한국어에 한자(漢字)가 섞여도
 * 한글이 이기고, 일본어에 한자가 섞여도 가나가 이긴다.
 *
 * **라틴 알파벳을 나눠 가지는 언어** — en/es/fr/de/pt 는 글자가 같으므로
 * 빌려 오는 말(아주 흔한 낱말)과 이 언어만이 쓰는 문자(ñ ß ã œ)로 점수를
 * 매긴다. 이긴 언어가 뒤따르는 언어를 확실히 앞서야 믿는다 — 문장 하나가
 * 어중간하게 걸리면 아무 말도 하지 않는 편이, 틀린 말을 하는 것보다 낫다.
 */

export type Detection = {
  /** 확신할 수 없으면 null 이다 */
  language: LanguageCode | null
}

/** 히라가나 · 가타카나 — 일본어의 유일한 증거 */
const KANA_RE = /[\u3041-\u309F\u30A0-\u30FF]/gu
/** 한글 — 한국어의 유일한 증거 (호환 자모 · 옛 글자 포함) */
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/gu
/** 한자 — 중국어와 일본어(칸지)가 나눠 쓴다 */
const HAN_RE = /[\u4E00-\u9FFF\u3400-\u4DBF]/gu

/** 한두 글자로는 판단하지 않는다 — 틀린 말이 빈 말보다 나쁘다 */
const MIN_LETTERS = 2
/** 한자만 있을 때 — 東京 같은 두 글자는 일본어 지명일 수도 있다 */
const MIN_HAN_FOR_ZH = 4
/** 라틴 언어는 이만큼은 받아야 점수를 믿는다 — 문장 하나 이상 */
const MIN_LATIN_CHARS = 24
/** 이긴 언어가 뒤따르는 언어보다 이만큼 앞서야 믿는다 */
const LATIN_MARGIN = 2
/** 고유 문자 하나당 점수 — 확실한 증거는 흔한 낱말보다 무겁다 */
const ACCENT_POINTS = 3

/** 이 언어만이 쓰는 글자 — 하나면 그 언어다 */
const UNIQUE_ACCENTS: Array<[LanguageCode, RegExp]> = [
  ['es', /[ñ¿¡]/u],
  ['pt', /[ãõ]/u],
  ['fr', /[œ]/u],
  ['de', /[ßäöü]/u],
]

/** 아주 흔한 낱말 — 문장이 어떤 언어인지 가장 빨리 알려 준다.
 *  겹치는 낱말(de, que, la …)은 그대로 둔다 — 이긴 쪽이 확실하게 앞서야 하므로. */
const COMMON_WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'was', 'in', 'that', 'it', 'with', 'for', 'on', 'are', 'this', 'be', 'you', 'we'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'con', 'no', 'al', 'del', 'por', 'para', 'muy'],
  fr: ['le', 'la', 'les', 'de', 'du', 'des', 'et', 'est', 'en', 'un', 'une', 'que', 'qui', 'nous', 'avec', 'au', 'aux', 'dans', 'pour', 'sur', 'ce', 'cette', 'pas'],
  de: ['der', 'die', 'das', 'und', 'ist', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'nicht', 'mit', 'ich', 'wir', 'auch', 'als', 'auf', 'für', 'im'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'um', 'uma', 'não', 'com', 'em', 'por', 'para', 'ao', 'aos', 'está', 'muito', 'uma'],
}

/** 라틴 언어만 — CJK 는 문자로 바로 안다 */
const LATIN_LANGUAGES = ['en', 'es', 'fr', 'de', 'pt'] as const

function lettersOf(text: string): string[] {
  return text.match(/\p{L}/gu) ?? []
}

/** 라틴 언어 점수표 — 겹치는 낱말이 있어도 이긴 쪽의 증거가 앞서면 믿는다 */
function latinScores(text: string): Map<LanguageCode, number> {
  const scores = new Map<LanguageCode, number>(
    LATIN_LANGUAGES.map((code) => [code, 0]),
  )

  const words = new Map<string, number>()
  for (const word of text.toLowerCase().match(/[\p{L}]+/gu) ?? []) {
    words.set(word, (words.get(word) ?? 0) + 1)
  }
  for (const [code, list] of Object.entries(COMMON_WORDS)) {
    if (!scores.has(code as LanguageCode)) continue
    for (const word of list) {
      const count = words.get(word) ?? 0
      scores.set(code as LanguageCode, (scores.get(code as LanguageCode) ?? 0) + count)
    }
  }

  for (const [code, re] of UNIQUE_ACCENTS) {
    if (!scores.has(code)) continue
    if (re.test(text)) scores.set(code, (scores.get(code) ?? 0) + ACCENT_POINTS)
  }

  return scores
}

/**
 * 언어를 알아낸다. 확신이 없으면 null — 부르는 쪽이 조용히 두기로 한다.
 */
export function detectLanguage(text: string): Detection {
  const letters = lettersOf(text)

  const kana = text.match(KANA_RE)?.length ?? 0
  const hangul = text.match(HANGUL_RE)?.length ?? 0
  const han = text.match(HAN_RE)?.length ?? 0

  if (kana > 0 && letters.length >= MIN_LETTERS) return { language: 'ja' }
  if (hangul > 0 && letters.length >= MIN_LETTERS) return { language: 'ko' }
  if (han >= MIN_HAN_FOR_ZH && kana === 0) return { language: 'zh' }

  if (text.length < MIN_LATIN_CHARS || letters.length < MIN_LETTERS) return { language: null }

  const scores = latinScores(text)
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const [winner, winnerScore] = ordered[0] ?? []
  const runnerUp = ordered[1]?.[1] ?? 0
  if (!winner || winnerScore < LATIN_MARGIN || winnerScore - runnerUp < LATIN_MARGIN) {
    return { language: null }
  }
  return { language: winner }
}
