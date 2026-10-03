/**
 * 활용형 → 사전형 후보 생성.
 *
 * 본문에 나오는 표기는 활용된 형태(속는다, 갑니다)인데 사전 항목은 기본형(속다, 가다)이다.
 * 형태소 분석기를 브라우저에 넣을 수는 없으므로, 사전을 못 찾으면 끝을 조금 잘라낸
 * 후보들을 순서대로 시도한다. 틀린 후보는 그냥 404 로 지나가므로 위험이 낮다.
 *
 * 이 후보는 "사전 조회"에만 쓴다. 학습 상태(○◐●)의 lemma 은 tokenizer 가 따로 만들므로
 * 여기서 틀려도 학습 기록이 오염되지 않는다.
 *
 * 대소문자(독일어 Holz 처럼 명사를 대문자로 쓰는 언어)는 여기서 다루지 않는다.
 * 그것은 표기를 보존해 조회하는 쪽의 책임이다.
 */

/**
 * 활용 규칙의 버전.
 * 이 값을 올리면 사전 캐시가 자동으로 무효가 된다 (사전 Edge Function 이 참조한다).
 * 규칙을 고치면서 올리는 걸 잊으면 옛 잘못된 결과가 캐시에 남는다 — 실제로 그랬다.
 */
export const INFLECTION_VERSION = '3'

const KO_INFINITIVE = '다'

/**
 * 후보가 어디서 나왔는지.
 * 'inflection' 인 후보만 "기본형"으로trusted할 수 있다 —
 * 예) 영어 running → run 은 기본형이지만, de/Haus 의 소문자 haus 는 다른 동사다.
 */
export type CandidateSource = 'exact' | 'inflection'

export type Candidate = { word: string; via: CandidateSource }

/**
 * 한국어 활용 어미 — 길이 긴 순으로 뒤에서부터 시도한다.
 *
 * 무지개 절단을 하지 않는다. 예쁘다 에서 ��1자를 떼면 예다 가 나오는데,
 * 예다 는 실제로 사전에 있는 다른 단어라 엉뚱한 뜻이 조용히 붙는다.
 * 알고 있는 어미만 벗겨내야 한다.
 */
const KO_ENDINGS: { ending: string; base: string }[] = [
  { ending: '습니다', base: KO_INFINITIVE },
  { ending: 'ㅂ니다', base: KO_INFINITIVE },
  { ending: '니다', base: KO_INFINITIVE },
  { ending: '는다', base: KO_INFINITIVE },
  { ending: 'ㄴ다', base: KO_INFINITIVE },
  { ending: '었다', base: KO_INFINITIVE },
  { ending: '었다', base: KO_INFINITIVE },
  { ending: '요', base: KO_INFINITIVE },
  { ending: '고', base: '' },
  { ending: '지', base: '' },
  // 명사 뒤 부속격 — '을/를/이/가/은/는' 은 실제 단어와 겹칠 수 있어 넣지 않는다
  { ending: '에서', base: '' },
  { ending: '에게', base: '' },
  { ending: '한테', base: '' },
]

function koreanInflections(lemma: string): string[] {
  const out: string[] = []

  for (const { ending, base } of KO_ENDINGS) {
    if (!lemma.endsWith(ending) || lemma.length <= ending.length) continue
    const candidate = lemma.slice(0, lemma.length - ending.length) + base
    if (candidate.length > 0 && candidate !== lemma) out.push(candidate)
  }

  // 집합·복수 접미사 (학생들 → 학생)
  if (lemma.endsWith('들') && lemma.length > 1) out.push(lemma.slice(0, -1))

  return [...new Set(out)]
}

/**
 * 영문 활용: 어간을 얻되 규칙이 지극히 제한적이다.
 * running → run (복음 환원), changed → change / chang, studies → study
 * 불규칙 변화(run/ran, go/went)는 못 잡는다 — 틀려도 조용히 404 다.
 */
function englishInflections(lemma: string): string[] {
  const out: string[] = []
  // 2글자는 다른 단어일 위험이 커서 버린다 (used → us 같은 오탐 방지)
  const push = (value: string) => {
    if (value.length >= 3) out.push(value)
  }

  if (lemma.endsWith('ing') && lemma.length > 5) {
    const stem = lemma.slice(0, -3)
    push(stem)
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1))
  }

  if (lemma.endsWith('ed') && lemma.length > 4) {
    push(lemma.slice(0, -2))
    push(lemma.slice(0, -1))
  }

  if (lemma.endsWith('ies') && lemma.length > 5) push(`${lemma.slice(0, -3)}y`)
  if (lemma.endsWith('es') && lemma.length > 4) push(lemma.slice(0, -2))
  if (lemma.endsWith('s') && !/(ss|us|is)$/.test(lemma) && lemma.length > 3) push(lemma.slice(0, -1))

  return [...new Set(out)]
}

function inflectionsFor(languageCode: string, lemma: string): string[] {
  switch (languageCode.split('-')[0]) {
    case 'ko':
      return koreanInflections(lemma)
    case 'en':
      return englishInflections(lemma)
    default:
      // 일본어 등은 활용 규칙이 너무 복잡해 자동 처리하지 않는다 (PLAN.md §8)
      return []
  }
}

/**
 * 사전 조회 후보를 순서대로 돌려준다. 첫 항목은 원형 그대로.
 * 상한을 두어 upstream 무한 호출을 막는다.
 */
export function lookupCandidates(
  languageCode: string,
  lemma: string,
  limit = 5,
): Candidate[] {
  if (lemma.length === 0) return [{ word: '', via: 'exact' }]

  const derived: Candidate[] = inflectionsFor(languageCode, lemma)
    .filter((word) => word !== lemma)
    .map((word) => ({ word, via: 'inflection' }))

  const candidates: Candidate[] = [{ word: lemma, via: 'exact' }, ...derived]
  return candidates.slice(0, limit)
}
// ── 원형어 추출 ───────────────────────────────────────────────────────────

/** 위키낱말의 문법 참조를 표시하는 태그 */
export function isFormOf(tags: string[] | undefined): boolean {
  return (tags ?? []).includes('form of')
}

/**
 * 활용 형태를 설명하는 표현.
 * "present participle and gerund of run", "past of leben" 등.
 * 활용어를 나열한 뒤 "of X" 로 끝나는 경우만 받아 오탐을 막는다.
 */
// "of" 뒤의 단어를 얻는다. 뒤에 "were" 같은 설명이 이어져도 상관없게
// 끝에 고정하지 않는다 (de/waren = "…preterite of sein: were").
const HEADWORD_AFTER_OF = /\bof\s+([^\s.:;,]+)/i

const FORM_PHRASE_RE = new RegExp(
  '\\b(?:plural|gerund|present participle|past participle|past tense|simple past|simple present|' +
    'third[\\s-]person|2nd[\\s-]person|first[\\s-]person|inflection|declension|conjugation|' +
    'alternative(?: spelling)?|past form|present form|preterite|verbal noun|transliteration|' +
    'imperfect|perfect|indicative|subjunctive|conditional|participle)\\b[^.]*?\\bof\\s+([^\\s.:;,]+)',
  'i',
)

/**
 * 뜻이 가리키는 원형어를 뽑는다.
 *
 * 두 경로가 있다.
 *  1) 위키낱말이 'form of' 로 표시한 항목 — "inflection of leben:"
 *     태그가 확실하므로 관대한 패턴을 쓴다.
 *  2) 태그 없이 활용 형태를 설명하는 항목 — "present participle of run"
 *
 * 어느 쪽이든 끝에 붙은 콜론·마침표를 제거한다. 그러지 않으면
 * "leben:" 을 그대로 조회해 원형을 놓친다.
 */
export function referencedHeadwords(senses: InflectionSense[] | undefined): string[] {
  const out: string[] = []

  for (const sense of senses ?? []) {
    const definition = sense.definition?.trim()
    if (!definition) continue

    const match = isFormOf(sense.tags)
      ? definition.match(HEADWORD_AFTER_OF)
      : definition.match(FORM_PHRASE_RE)

    const word = match?.[1]?.replace(/[.:;,'"]+$/, '')
    if (word && word.length > 1) out.push(word)
  }

  return [...new Set(out)]
}

type InflectionSense = { definition?: string; tags?: string[] }
