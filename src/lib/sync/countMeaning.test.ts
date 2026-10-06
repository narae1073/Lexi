import { describe, expect, it } from 'vitest'

import { mergeWordStates, type WordStateRecord } from './merge'

/**
 * 화면에 보이는 숫자가 **무엇을 센 것인지.**
 *
 * 사용자가 '단어 개수 말하는 거야?' 라고 물었다. 모호한 숫자는 서로 다른 문제로 이어진다
 * — 서버가 비었는지, 이 기기에 기록이 없는지, 화면만 안 갱신된 것인지가 전부 '0' 으로
 * 보일 수 있기 때문이다.
 */
const row = (over: Partial<WordStateRecord> = {}): WordStateRecord => ({
  languageCode: 'fr',
  lemma: 'été',
  status: 'known',
  seenCount: 1,
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-05T00:00:00.000Z',
  ...over,
})

describe('보낸 단어 수', () => {
  it('서버에 없던 **서로 다른 단어** 수다', () => {
    const local = [row({ lemma: 'a' }), row({ lemma: 'b' }), row({ lemma: 'c' })]
    const { pushOnly } = mergeWordStates(local, [])
    expect(pushOnly).toHaveLength(3)
  })

  /**
   * 등장 횟수가 아니다.
   *
   * `seenCount` 이 아무리 커도 하나다 — 같은 단어가 백 번 나와도 배우는 대상은 하나다.
   */
  it('등장 횟수가 아니라 단어 수다', () => {
    const local = [row({ lemma: 'a', seenCount: 500 })]
    const { pushOnly } = mergeWordStates(local, [])
    expect(pushOnly).toHaveLength(1)
  })

  it('같은 단어가 여러 언어면 따로 센다', () => {
    const local = [row({ lemma: 'chat', languageCode: 'fr' }), row({ lemma: 'chat', languageCode: 'de' })]
    expect(mergeWordStates(local, []).pushOnly).toHaveLength(2)
  })

  it('서버에 이미 있으면 보내지 않는다', () => {
    const local = [row({ lemma: 'a' })]
    const remote = [row({ lemma: 'a', languageCode: 'fr' })]
    expect(mergeWordStates(local, remote).pushOnly).toHaveLength(0)
  })
})

describe('받은 단어 수', () => {
  it('서버에 있고 이 기기에 없는 **서로 다른 단어** 수다', () => {
    const local = [row({ lemma: 'a' })]
    const remote = [row({ lemma: 'a' }), row({ lemma: 'b' }), row({ lemma: 'c' })]
    const { pullOnly } = mergeWordStates(local, remote)
    expect(pullOnly.map((r) => r.lemma)).toEqual(['b', 'c'])
  })

  it('이 기기에 이미 있으면 받지 않는다 — 도착한 것이지 새로 온 것이 아니다', () => {
    const local = [row({ lemma: 'a' })]
    const remote = [row({ lemma: 'a' })]
    expect(mergeWordStates(local, remote).pullOnly).toHaveLength(0)
  })
})

describe('서버 / 이 기기 숫자', () => {
  it('서버와 이 기기의 서로 다른 단어 수다', () => {
    const local = [row({ lemma: 'a' }), row({ lemma: 'b' })]
    const remote = [row({ lemma: 'a' }), row({ lemma: 'c' })]
    const { merged } = mergeWordStates(local, remote)
    // 합쳐진 쪽은 세 개 — 서버 / 이 기기 각각의 숫자가 아니다
    expect(new Set(merged.map((r) => r.lemma)).size).toBe(3)
  })
})