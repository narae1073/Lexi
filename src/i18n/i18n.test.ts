import { describe, expect, it } from 'vitest'

import { createTranslator, interpolate } from './index'
import { en } from './locales/en'
import { ko } from './locales/ko'

describe('사전 무결성', () => {
  /** en 을 기준으로 다른 사전이 같은 키를 갖고 있는지 확인한다 */
  it('모든 사전이 같은 키 집합을 가진다', () => {
    const flatten = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? flatten(value, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      )

    const enKeys = flatten(en).sort()
    expect(flatten(ko).sort()).toEqual(enKeys)
  })

  /** Recovery controls and storage status must be readable in both app languages. */
  it('recovery and storage copy exists in every dictionary', () => {
    const flatten = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? flatten(value, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      )

    const required = [
      'account.refreshAll',
      'account.refreshAllHint',
      'account.clockRollback',
      'settings.storageTitle',
      'settings.storagePersisted',
      'settings.storageNotPersisted',
      'settings.storageRequest',
      'settings.storageUsage',
      'settings.storageUnavailable',
    ]

    for (const key of required) {
      expect(flatten(en)).toContain(key)
      expect(flatten(ko)).toContain(key)
    }
  })
})

describe('interpolate', () => {
  it('값을 치환한다', () => {
    expect(interpolate('{count}자', { count: 42 })).toBe('42자')
  })

  it('숫자도 문자열로 넣는다', () => {
    expect(interpolate('a {n} b', { n: 7 })).toBe('a 7 b')
  })

  it('없는 키는 원래 표기대로 둔다', () => {
    expect(interpolate('{missing} stays', { other: 1 })).toBe('{missing} stays')
  })

  it('파라미터가 없으면 그대로 둔다', () => {
    expect(interpolate('{count}자')).toBe('{count}자')
  })
})

describe('createTranslator', () => {
  it('영어는 기본 언어다', () => {
    expect(createTranslator('en')('compose.create')).toBe('Create document')
  })

  it('한국어로 전환된다', () => {
    expect(createTranslator('ko')('compose.create')).toBe('문서 만들기')
  })

  it('중첩 키를 읽는다', () => {
    expect(createTranslator('en')('sentence.translating')).toBe('Translating…')
  })

  it('파라미터를 넘긴다', () => {
    expect(createTranslator('en')('reader.stats', { words: 3, sentences: 1 })).toBe(
      '3 words · 1 sentences',
    )
  })

  it('알 수 없는 키는 키 문자열을 그대로 돌려준다', () => {
    expect(createTranslator('en')('languageNames.zz' as never)).toBe('languageNames.zz')
  })
})