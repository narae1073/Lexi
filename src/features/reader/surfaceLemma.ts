import type { LanguageCode } from '../../types'
import { normalizeLemma } from './tokenizer'

/**
 * 문서 안에서 실제로 쓰인 표기와, 그 표기를 대표할 lemma 의 대응.
 *
 * 왜 이 문제가 있는가:
 * 정규화는 소문자 접기로 시작하는데, 그것만 하면 서로 다른 단어가 한 상태로 합쳐진다.
 *   us(대명사) 와 US(국가) → us
 *   may(동사) 와 May(5월) → may
 * 어느 쪽이든 "모름"으로 표시하면 반대쪽까지 "모름" 이 된다.
 *
 * 규칙: **위치에서 온 것이 아닌 곳에도 대문자 표기로 쓰였다면 그것은 서로 다른 단어로 본다.**
 * 첫머리의 대문자는 철자 규칙(orthography)일 뿐 단어의 차이가 아니기 때문이다.
 *
 * '위치에서 온 대문자' 는 문장 첫머리뿐만이 아니다 — 콜론·세미콜론·여는 괄호·여는
 * 따옴표·대시 뒤에도 온다. 이 앱의 `isCapitalisedPosition` 이 그 자리들을 센다.
 * 세지 않으면 `Voici : Pour …` 의 Pour 가 고유명사로 굳어 `pour` 와 갈라진다.
 *   "The house" + "the dog"      → The 는 첫머리 전용 → the 로 합쳐짐  ✓
 *   "US and us"                  → US 가 중간에도 나옴 → 서로 다른 단어   ✓
 *   "May is warm. I may go."     → may 로 합쳐짐 (오병합 — §한계 참조)
 *
 * 한계: 문장 첫머리에만 나오는 고유명사가 같은 소문자 표기와 함께 쓰이면 합쳐진다
 * (예: "Apple released. I ate an apple."). 사전 조회를 붙여 구분하려면
 * 네트워크 호출이 필요해 자동으로 하지 않는다.
 */

/**
 * 표기 → lemma 규칙의 버전.
 *
 * 저장된 등장 기록은 이 규칙으로 계산된 결과다. 규칙을 고치면 옛 기록은
 * 조용히 틀린 상태로 남고, 문서를 직접 열어야만 다시 계산된다.
 * 그때까지는 같은 문서인데 기기마다 다른 단어가 보인다.
 *
 * 규칙을 바꿀 때마다 올린다 (PLAN.md — 표기 규칙 변경 시).
 */
export const LEMMA_VERSION = 4

export type SurfaceUsage = {
  surface: string
  /** 문서 전체 출현 횟수 */
  count: number
  /** 문장 첫머리가 아닌 위치에서의 출현 횟수 */
  nonInitialCount: number
}

/** 대문자를 하나라도 포함하는 표기인가 */
function hasUpper(text: string): boolean {
  return /\p{Lu}/u.test(text)
}

/**
 * 대소문자를 유지한 정규화.
 * "서로 다른 단어" 로 판정된 표기는 접으면 안 된다 —
 * US 와 us 를 분리하려고 해놓고 정규화가 다시 us 로 접으면 판정이 무의미해진다.
 */
function normalizeKeepingCase(word: string): string {
  const possessive = word.match(/^(.+?)['’]s$/)
  if (possessive && !/^(it|he|she|that's|what's|who's|let's)$/i.test(possessive[1])) {
    return possessive[1]
  }
  return word
}

/** 표기별 출현 정보를 모은다 (세그먼트에서 추출) */
export function collectSurfaceUsages(
  words: { text: string; sentenceInitial: boolean }[],
): SurfaceUsage[] {
  const bySurface = new Map<string, SurfaceUsage>()

  for (const { text, sentenceInitial } of words) {
    const existing = bySurface.get(text)
    if (existing) {
      existing.count += 1
      if (!sentenceInitial) existing.nonInitialCount += 1
      continue
    }
    bySurface.set(text, {
      surface: text,
      count: 1,
      nonInitialCount: sentenceInitial ? 0 : 1,
    })
  }

  return [...bySurface.values()]
}

/**
 * 표기 → 대표 lemma 매핑을 만든다.
 * 같은 표기가 여러 번 나와도 한 번만 계산한다.
 */
export function resolveSurfaceLemmas(
  usages: SurfaceUsage[],
  languageCode?: LanguageCode,
): Map<string, string> {
  // 접힌 키(소문자)로 묶는다 — 소유격 처리는 normalizeLemma 과 같은 규칙을 쓴다
  const groups = new Map<string, SurfaceUsage[]>()
  for (const usage of usages) {
    const key = normalizeLemma(usage.surface, languageCode)
    const group = groups.get(key)
    if (group) group.push(usage)
    else groups.set(key, [usage])
  }

  const mapping = new Map<string, string>()

  for (const group of groups.values()) {
    const lowercase = group.find((u) => !hasUpper(u.surface))

    for (const usage of group) {
      // ① 문장 중간에도 나온 대문자 표기 = 문장 첫머리 규칙의 산물이 아니므로 대소문자를 지킨다.
      //    US(국가) 와 Apple 같은 고유명사가 여기 걸린다.
      if (hasUpper(usage.surface) && usage.nonInitialCount > 0) {
        mapping.set(usage.surface, normalizeKeepingCase(usage.surface))
        continue
      }

      // ② 문장 첫머리에만 나오는 대문자 = 철자 규칙일 가능성이 높다 → 소문자와 합친다
      const isOrthographicVariant =
        hasUpper(usage.surface) && usage.nonInitialCount === 0 && Boolean(lowercase)
      if (isOrthographicVariant) {
        mapping.set(usage.surface, normalizeLemma(lowercase!.surface, languageCode))
        continue
      }

      // ③ 구별을 증명할 수 없으면 접는다.
      //    문서를 넘나들며 학습 상태가 쪼개지는 것보다 나쁘지 않은 선택이고,
      //    사전 조회는 표기(surface)를 따로 보내므로 대소문자가 없어도 정확히 동작한다.
      mapping.set(usage.surface, normalizeLemma(usage.surface, languageCode))
    }
  }

  return mapping
}

/** 편의 함수: 표기 목록만 받아 곧바로 매핑을 만든다 */
export function resolveLemmasFromWords(
  words: { text: string; sentenceInitial: boolean }[],
  languageCode?: LanguageCode,
) {
  return resolveSurfaceLemmas(collectSurfaceUsages(words), languageCode)
}