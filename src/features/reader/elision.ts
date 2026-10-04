import type { LanguageCode } from '../../types'

/**
 * 프랑스어 축약 (élision).
 *
 * 짧은 기능어가 모음 앞에서 끝 음절을 잃는다 — de + été → d'été.
 *
 * 이 앱에서 왜 필요한가: 축약은 한 단어로 토큰화된다. 지금은 표기가 그대로 lemma 가
 * 되어 `d'été` 를 조회한다 — 사전에 없는 표기라 "찾는 중" 에서 멈추거나 엉뚱한
 * 뜻이 나온다. 그리고 같은 문서의 `été` 와는 다른 단어로 세어진다. 배우는 사람이
 * 보기에는 둘은 같은 말이다.
 *
 * **'예외없이' 하지는 않는다.** 세 가지를 지킨다.
 *
 * 1. 어두운 고유명사 — 프랑스어는 아포스트로피 뒤의 고유명사를 대문자로 쓴다.
 *    `d'Artagnan`, `l'École` → 접지 않는다. `d'été` 처럼 소문자면 접는다.
 *    문장 첫머리여도 상관없다 — 접히고 남는 'd' 가 아니라 그 뒤 글자가 대문자인지를 본다.
 * 2. 남은 부분에 또 아포스트로피가 있으면 접지 않는다 — 안전한 편이 낫다.
 * 3. 남은 부분은 한 글자여도 된다 — `t'y` 는 te + y 다.
 *
 * **qu' 는 넣지 않았다.** qu' 은 뒤에 주어 대명자(il·elle·on)나 동사(est·sont)가 오는데,
 * 남아 있는 쪽이 뜻의 중심이 아니다 — qu'il 에서 배울 단어는 `il` 이 아니라 `qui` 다.
 * 어느 쪽으로 접어도 틀리며, 접지 않으면 최소한 사전 조회는 원형 그대로다.
 */
const ELISION_PREFIXES = ['d', 'l', 'n', 'c', 'j', 'm', 't', 's'] as const

/** 아포스트로피 계열 — 토크나이저가 쓰는 것과 같은 세 가지 */
const APOSTROPHES = new Set(["'", '’', 'ʼ'])

/** 아포스트로피 앞에 놓일 수 있는 글자들 */
const PREFIX_CHARS = new Set<string>(ELISION_PREFIXES)

/**
 * 프랑스어 축약을 푼다. 해당 없으면 null.
 *
 * 표기는 그대로 두고 lemma 만 내보낸다 — 화면에는 원래 쓴 모습이 보여야 한다.
 */
export function stripFrenchElision(word: string): string | null {
  // 앞글자 대소문자는 보지 않는다 — 문장 첫머리라서 대문자였을 뿐이다
  // (L'été, D'abord, J'ai). 고유명사 여부는 **아포스트로피 뒤** 글자로 갈린다.
  const first = word[0].toLowerCase()
  const apostrophe = word[1]
  if (!PREFIX_CHARS.has(first) || !APOSTROPHES.has(apostrophe)) return null

  const rest = word.slice(2)

  // 고유명사 — d'Artagnan, l'École. 프랑스어의 관습이 여기서 갈라 준다
  if (!/^\p{Ll}/u.test(rest[0] ?? '')) return null

  // 남은 쪽에 또 아포스트로피가 있으면 우리가 아는 축약이 아니다
  for (const ch of rest) {
    if (APOSTROPHES.has(ch)) return null
  }

  return rest
}

/**
 * 언어별 축약 접기.
 *
 * 지금은 프랑스어만 한다. 다른 언어의 규칙을 더 넣을 자리를 여기 둔다.
 */
export function stripElision(word: string, languageCode?: LanguageCode): string | null {
  if (languageCode === 'fr') return stripFrenchElision(word)
  return null
}