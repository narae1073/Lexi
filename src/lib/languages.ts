/**
 * 배울 언어 화이트리스트 (PLAN.md §9-2 미결정 항목의 기본값).
 * 사전이 지원하는 언어를 전부 목록에 넣으면 복잡하므로 이것만 노출한다 (plan.txt 5줄).
 *
 * SupportedLanguageCode 는 이 배열이 유일한 기준점이다.
 * types/index.ts 가 여기서 유니온을 가져가므로 순환이 없도록 이 파일은 types 를 import 하지 않는다.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', nativeLabel: 'English', dictionary: 'free-en', cjk: false },
  { code: 'ja', nativeLabel: '日本語', dictionary: 'google', cjk: true },
  { code: 'ko', nativeLabel: '한국어', dictionary: 'google', cjk: false },
  { code: 'es', nativeLabel: 'Español', dictionary: 'google', cjk: false },
  { code: 'fr', nativeLabel: 'Français', dictionary: 'google', cjk: false },
  { code: 'de', nativeLabel: 'Deutsch', dictionary: 'google', cjk: false },
  { code: 'pt', nativeLabel: 'Português', dictionary: 'google', cjk: false },
  { code: 'zh', nativeLabel: '中文', dictionary: 'google', cjk: true },
] as const satisfies readonly SupportedLanguageShape[]

type SupportedLanguageShape = {
  code: string
  nativeLabel: string
  dictionary: 'free-en' | 'google' | 'none'
  /** 공백 없는 언어 — 토크나이저가 Intl.Segmenter 분절을 우선해야 함 (PLAN.md §5.1) */
  cjk: boolean
}

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** 배울 언어로 선택할 수 있는 코드 */
export type SupportedLanguageCode = SupportedLanguage['code']

const BY_CODE = new Map<string, SupportedLanguage>(
  SUPPORTED_LANGUAGES.map((lang) => [lang.code, lang]),
)

export function getLanguage(code: string): SupportedLanguage | undefined {
  return BY_CODE.get(code)
}

/** 이 언어를 배우면 뜻은 영어로 보여준다 (PLAN.md §1 언어 방향) */
export const DEFINITION_LANGUAGE = 'en' as const