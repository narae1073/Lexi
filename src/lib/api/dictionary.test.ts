import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 회귀 테스트.
 *
 * 패널은 원본 lemma 으로 캐시 키를 만들고 스토어는 소문자로 만들었다.
 * 그랬더니 표 대문자 단어(독일어 명사 등)는 요청이 성공해도 패널이 캐시를
 * 찾지 못하고 "찊는 중" 에서 영원히 멈췄다 — e2e 05-inflection 이 이걸 잡았다.
 * 키를 계산하는 방법이 두 곳이어서가면 반드시 이런 일이 생긴다.
 */
const invoke = vi.fn()

vi.mock('../supabase/client', () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invoke(...args),
    },
  },
}))

const { dictionaryKey, useDictionaryStore } = await import('./dictionary')

function entry(lemma: string) {
  return {
    found: true,
    lemma,
    languageCode: 'de' as const,
    sections: [],
    cached: false,
  }
}

describe('dictionaryKey', () => {
  beforeEach(() => {
    invoke.mockReset()
    useDictionaryStore.setState({ entries: {}, inFlight: new Map() })
    invoke.mockResolvedValue({ data: entry('häuser'), error: null })
  })

  it('대소문자와 앞뒤 공백을 정규화한다', () => {
    expect(dictionaryKey('de', 'Häuser')).toBe('de::häuser')
    expect(dictionaryKey('de', '  häuser  ')).toBe('de::häuser')
    expect(dictionaryKey('de', 'HÄUSER')).toBe(dictionaryKey('de', 'häuser'))
  })

  it('결과가 패널이 찾는 키 자리에 저장된다', async () => {
    await useDictionaryStore.getState().lookup('de', 'Häuser')
    // 패널은 이 키로 캐시를 찾는다
    expect(useDictionaryStore.getState().entries[dictionaryKey('de', 'Häuser')]).toBeDefined()
  })

  it('대소문자가 달라도 같은 단어로 취급해 재사용한다', async () => {
    await useDictionaryStore.getState().lookup('de', 'Häuser')
    await useDictionaryStore.getState().lookup('de', 'häuser')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('요청 본문에는 표기를 그대로 보낸다', async () => {
    await useDictionaryStore.getState().lookup('de', 'Häuser', 'Häuser')
    expect(invoke).toHaveBeenCalledWith('dictionary', {
      body: { languageCode: 'de', lemma: 'häuser', surface: 'Häuser' },
    })
  })
})