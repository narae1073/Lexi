import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { isPurged, markPurged, purgedDocumentIds } from './purged'

/**
 * 이 프로젝트에는 jsdom 이 없다 — localStorage 를 직접 쓰는 코드는 시험할 수 없다.
 *
 * 저장 계약만 그대로 만족하는 스텁을 세운다. 그래야 '무엇을 기억하고 무엇을 버리는가'
 * 를 서버 없이 볼 수 있다.
 */
class MemoryStorage {
  #map = new Map<string, string>()

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null
  }

  setItem(key: string, value: string) {
    this.#map.set(key, String(value))
  }

  removeItem(key: string) {
    this.#map.delete(key)
  }

  clear() {
    this.#map.clear()
  }

  key(index: number) {
    return [...this.#map.keys()][index] ?? null
  }

  get length() {
    return this.#map.size
  }
}

beforeAll(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage
})

/**
 * 완전 삭제한 문서를 기억한다.
 *
 * 회귀: 삭제 요청과 동기화가 겹치면 지운 문서가 서버에서 그대로 내려와 되살아난다.
 * 병합이 그것을 되살리고, 다음 동기화가 되살아난 것을 서버에 다시 올린다 — 지운
 * 문서가 영구히 돌아온다.
 *
 * 그래서 '이 기기에서 지웠다'는 사실을 기억해 두고, 서버가 무엇을 돌려주든 받지 않는다.
 */
describe('완전 삭제 기억', () => {
  beforeEach(() => {
    localStorage.removeItem('lexi.purged')
  })

  it('지운 문서를 기억한다', () => {
    markPurged('doc-1')
    expect(isPurged('doc-1')).toBe(true)
    expect(purgedDocumentIds()).toEqual(['doc-1'])
  })

  it('지우지 않은 문서는 기억하지 않는다', () => {
    markPurged('doc-1')
    expect(isPurged('doc-2')).toBe(false)
  })

  it('같은 것을 두 번 지워도 한 번만 남는다', () => {
    markPurged('doc-1')
    markPurged('doc-1')
    expect(purgedDocumentIds()).toEqual(['doc-1'])
  })

  it('여러 개를 지워도 모두 기억한다', () => {
    markPurged('doc-1')
    markPurged('doc-2')
    markPurged('doc-3')
    expect(purgedDocumentIds()).toHaveLength(3)
  })

  /**
   * '완전 삭제' 의 뜻이 그것이다. 서버 삭제 요청이 늦어져 잠시 다시 내려와도
   * 받아들이지 않는다 — 받아들이면 되살아난다.
   */
  it('잊지 않는다 — 서버 삭제 요청이 늦어도 다시 받지 않는다', () => {
    markPurged('doc-1')
    // 시간이 지나도 그대로다
    expect(isPurged('doc-1')).toBe(true)
  })

  it('저장된 것이 없으면 빈 목록이다', () => {
    expect(purgedDocumentIds()).toEqual([])
    expect(isPurged('doc-1')).toBe(false)
  })

  it('망가진 값이 들어 있어도 버리지 않는다 — 조용히 없는 것으로 본다', () => {
    localStorage.setItem('lexi.purged', 'not json')
    expect(purgedDocumentIds()).toEqual([])
    expect(isPurged('doc-1')).toBe(false)
  })

  it('숫자가 섞여 있어도 문자열만 남긴다', () => {
    localStorage.setItem('lexi.purged', JSON.stringify(['doc-1', 42, null]))
    expect(purgedDocumentIds()).toEqual(['doc-1'])
  })
})