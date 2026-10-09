import { describe, expect, it, vi } from 'vitest'

import { segmentChinese } from './chinese'
import * as lindera from './lindera'

/**
 * lindera 없이 규칙만 시험한다 — 사전은 무겁고 네트워크가 필요하므로
 * 단위 시험에 올리지 않는다. 실제 분절 품질은 e2e(29)에서 본다.
 *
 * 토크나이저를 가짜로 끼운다: peekLindera 를 모듈 모킹 대신 vi.spyOn 으로
 * 갈아끼우면 segmentChinese 의 순수 부분만 돈다.
 */
function fakeTokenizer(surfaces: string[]) {
  let byte = 0
  const tokens = surfaces.map((surface) => {
    const bytes = new TextEncoder().encode(surface).length
    const token = { surface, byteStart: byte, byteEnd: byte + bytes }
    byte += bytes
    return token
  })
  return { tokenize: () => tokens }
}

function segmentWith(text: string, surfaces: string[]) {
  const spy = vi.spyOn(lindera, 'peekLindera').mockReturnValue(fakeTokenizer(surfaces))
  try {
    return segmentChinese(text)
  } finally {
    spy.mockRestore()
  }
}

describe('segmentChinese', () => {
  it('준비되지 않았으면 null — 호출부는 Intl 로 폴백한다', () => {
    const spy = vi.spyOn(lindera, 'peekLindera').mockReturnValue(null)
    try {
      expect(segmentChinese('中文')).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('형태소 하나가 단어 하나, lemma 는 표기 그대로', () => {
    const result = segmentWith('我喜欢中文', ['我', '喜欢', '中文'])
    const words = result?.segments.filter((s) => s.type === 'word') ?? []
    expect(words.map((w) => w.text)).toEqual(['我', '喜欢', '中文'])
    expect(result?.lemmaByStart.get(0)).toBe('我')
    expect(result?.lemmaByStart.get(1)).toBe('喜欢')
  })

  it('기호·숫자는 단어가 아니다 — 본문 토크나이저와 같은 규칙', () => {
    const result = segmentWith('吃了3个。', ['吃', '了', '3', '个', '。'])
    const words = result?.segments.filter((s) => s.type === 'word') ?? []
    expect(words.map((w) => w.text)).toEqual(['吃', '了', '个'])
    // 빈틈없이 덮는다 — 숫자·기호 자리는 text 다
    expect(result?.segments.map((s) => s.text).join('')).toBe('吃了3个。')
  })

  it('같은 표기가 겹쳐도 자리마다 lemma 를 따로 안다', () => {
    const result = segmentWith('人人', ['人', '人'])
    expect(result?.lemmaByStart.get(0)).toBe('人')
    expect(result?.lemmaByStart.get(1)).toBe('人')
    expect(result?.segments.filter((s) => s.type === 'word')).toHaveLength(2)
  })
})
