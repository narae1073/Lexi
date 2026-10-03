import { en, type Dictionary } from './locales/en'
import { ko } from './locales/ko'

export type AppLanguage = 'en' | 'ko'

/**
 * 앱 UI 언어 (배울 언어와는 별개다).
 * 배울 언어는 lib/languages.ts, 앱 UI 언어는 여기다.
 */
export const APP_LANGUAGES: { code: AppLanguage; nativeLabel: string }[] = [
  { code: 'en', nativeLabel: 'English' },
  { code: 'ko', nativeLabel: '한국어' },
]

export const DEFAULT_APP_LANGUAGE: AppLanguage = 'en'

const DICTIONARIES: Record<AppLanguage, Dictionary> = { en, ko }

/** "compose.title" 같은 점 표기로 접근하기 위한 타입 */
type DotPath<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${DotPath<T[K]>}`
}[keyof T & string]

export type TranslationKey = DotPath<Dictionary>

type Params = Record<string, string | number>

export type Translator = (key: TranslationKey, params?: Params) => string

function lookup(dict: Dictionary, key: string): string {
  let node: unknown = dict
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : key
}

export function interpolate(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

export function createTranslator(language: AppLanguage): Translator {
  const dict = DICTIONARIES[language] ?? DICTIONARIES[DEFAULT_APP_LANGUAGE]
  return (key, params) => interpolate(lookup(dict, key), params)
}