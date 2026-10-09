import { describe, expect, it } from 'vitest'

import { mergeLanguages, mergeWordStates, type WordStateRecord } from './merge'

/** t0/t1/t2 는 서로 다른 시각 — ISO 문자열은 그 자체로 시간순이 된다 */
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'
const T2 = '2026-01-03T00:00:00.000Z'

function rec(over: Partial<WordStateRecord> & { lemma: string }): WordStateRecord {
  return {
    languageCode: 'en',
    status: undefined,
    seenCount: 1,
    firstSeenAt: T0,
    lastSeenAt: T0,
    favorite: false,
    favoriteUpdatedAt: T0,
    ...over,
  }
}

const find = (list: WordStateRecord[], lemma: string) => list.find((r) => r.lemma === lemma)

describe('mergeWordStates — 어느 쪽을 이기는가', () => {
  it('마지막 조작이 더 최근인 쪽의 상태를 쓴다 (plan.txt: last_seen_at 최신)', () => {
    const local = [rec({ lemma: 'apple', status: 'known', lastSeenAt: T2 })]
    const remote = [rec({ lemma: 'apple', status: 'unknown', lastSeenAt: T1 })]

    const { merged } = mergeWordStates(local, remote)
    expect(find(merged, 'apple')?.status).toBe('known')
  })

  it('서버 쪽이 더 최근이면 서버 상태를 쓴다', () => {
    const local = [rec({ lemma: 'apple', status: 'known', lastSeenAt: T1 })]
    const remote = [rec({ lemma: 'apple', status: 'unknown', lastSeenAt: T2 })]

    expect(find(mergeWordStates(local, remote).merged, 'apple')?.status).toBe('unknown')
  })

  it('시각이 같으면 사용자가 직접 고른 상태를 쓴다', () => {
    const local = [rec({ lemma: 'apple', lastSeenAt: T1 })] // 아직 고르지 않음
    const remote = [rec({ lemma: 'apple', status: 'unknown', lastSeenAt: T1 })]

    expect(find(mergeWordStates(local, remote).merged, 'apple')?.status).toBe('unknown')
  })

  it('둘 다 고르지 않았으면 로컬을 유지한다 — 결정론이 있어야 같다', () => {
    const local = [rec({ lemma: 'apple', lastSeenAt: T1, firstSeenAt: T0 })]
    const remote = [rec({ lemma: 'apple', lastSeenAt: T1, firstSeenAt: T0 })]

    expect(find(mergeWordStates(local, remote).merged, 'apple')?.firstSeenAt).toBe(T0)
  })

  it('언어가 다르면 같은 단어도 다른 단어로 본다', () => {
    const local = [rec({ lemma: 'son', languageCode: 'en', status: 'known' })]
    const remote = [rec({ lemma: 'son', languageCode: 'ja', status: 'unknown' })]

    const { merged } = mergeWordStates(local, remote)
    expect(merged).toHaveLength(2)
    expect(find(merged, 'son')?.languageCode).toBe('en')
  })
})

describe('mergeWordStates — push / pull 대상', () => {
  it('로컬에만 있는 단어는 서버로 보낸다', () => {
    const { pushOnly, pullOnly } = mergeWordStates([rec({ lemma: 'apple' })], [])
    expect(pushOnly.map((r) => r.lemma)).toEqual(['apple'])
    expect(pullOnly).toEqual([])
  })

  it('서버에만 있는 단어는 받아온다', () => {
    const { pushOnly, pullOnly } = mergeWordStates([], [rec({ lemma: 'apple' })])
    expect(pullOnly.map((r) => r.lemma)).toEqual(['apple'])
    expect(pushOnly).toEqual([])
  })

  it('서버와 같으면 다시 보내지 않는다 — 무한 갱신을 막는다', () => {
    const same = rec({ lemma: 'apple', status: 'known', lastSeenAt: T1 })
    const { pushOnly } = mergeWordStates([same], [{ ...same }])
    expect(pushOnly).toEqual([])
  })

  it('결과가 바뀌었을 때만 서버로 보낸다', () => {
    const local = [rec({ lemma: 'apple', status: 'known', lastSeenAt: T2 })]
    const remote = [rec({ lemma: 'apple', status: 'unknown', lastSeenAt: T1 })]
    expect(mergeWordStates(local, remote).pushOnly.map((r) => r.status)).toEqual(['known'])
  })

  it('기존 단어가 같으면 아무것도 오가지 않는다', () => {
    const both = [rec({ lemma: 'apple', status: 'known' })]
    const { pushOnly, pullOnly } = mergeWordStates(both, both)
    expect(pushOnly).toEqual([])
    expect(pullOnly).toEqual([])
  })
})

describe('mergeWordStates — 합성 필드', () => {
  it('seen_count 는 큰 값 — 같은 값을 여러 번 합치면 숫자가 불어난다', () => {
    const local = [rec({ lemma: 'apple', seenCount: 3 })]
    const remote = [rec({ lemma: 'apple', seenCount: 7 })]
    expect(find(mergeWordStates(local, remote).merged, 'apple')?.seenCount).toBe(7)
  })

  it('처음 본 시각은 이른 값', () => {
    const local = [rec({ lemma: 'apple', firstSeenAt: T2, lastSeenAt: T2 })]
    const remote = [rec({ lemma: 'apple', firstSeenAt: T0, lastSeenAt: T1 })]
    const merged = find(mergeWordStates(local, remote).merged, 'apple')
    expect(merged?.firstSeenAt).toBe(T0)
    expect(merged?.lastSeenAt).toBe(T2)
  })
})

/**
 * 별은 상태와 따로 병합한다.
 *
 * 행 전체를 '늦은 쪽이 이긴다' 로 하면 이런 일이 생긴다: A 기기에서 별을 뗐는데
 * B 기기에서 상태를 바꾸면 B 행이 더 늦어 별이 되살아난다. 사용자가 직접
 * 뗀 별이 돌아오면 앱이 말을 안 듣는 것처럼 보인다.
 */
describe('mergeWordStates — 즐겨찾기', () => {
  it('별의 시각이 늦은 쪽이 이긴다', () => {
    const local = [rec({ lemma: 'apple', favorite: true, favoriteUpdatedAt: T2 })]
    const remote = [rec({ lemma: 'apple', favorite: false, favoriteUpdatedAt: T1 })]
    expect(find(mergeWordStates(local, remote).merged, 'apple')?.favorite).toBe(true)
  })

  it('별을 뗀 것이 늦으면 상태 변경에 묻히지 않는다', () => {
    // A: 별을 뗐다 (T2). B: 상태를 바꾸고 별은 옛날 그대로 true (T0).
    // B 행이 상태 시각으로는 더 늦어도 별은 A 것이 이겨야 한다.
    const local = [
      rec({ lemma: 'apple', status: 'known', lastSeenAt: T1, favorite: false, favoriteUpdatedAt: T2 }),
    ]
    const remote = [
      rec({ lemma: 'apple', status: 'unknown', lastSeenAt: T2, favorite: true, favoriteUpdatedAt: T0 }),
    ]
    const merged = find(mergeWordStates(local, remote).merged, 'apple')
    expect(merged?.status).toBe('unknown')
    expect(merged?.favorite).toBe(false)
  })

  it('별의 시각이 같으면 합집합 — 붙인 별을 잃지 않는다', () => {
    const local = [rec({ lemma: 'apple', favorite: true, favoriteUpdatedAt: T1 })]
    const remote = [rec({ lemma: 'apple', favorite: false, favoriteUpdatedAt: T1 })]
    expect(find(mergeWordStates(local, remote).merged, 'apple')?.favorite).toBe(true)
  })

  it('별만 바뀌어도 서버에 보낸다', () => {
    const local = [rec({ lemma: 'apple', status: 'known', favorite: true, favoriteUpdatedAt: T2 })]
    const remote = [rec({ lemma: 'apple', status: 'known', favorite: false, favoriteUpdatedAt: T1 })]
    const { pushOnly } = mergeWordStates(local, remote)
    expect(pushOnly).toHaveLength(1)
    expect(pushOnly[0]?.favorite).toBe(true)
  })
})

describe('mergeWordStates — 반복해도 같다 (idempotent)', () => {
  it('같은 입력으로 몇 번 돌려도 결과가 변하지 않는다', () => {
    const local = [
      rec({ lemma: 'apple', status: 'known', lastSeenAt: T2, seenCount: 4 }),
      rec({ lemma: 'pear', status: 'unsure', lastSeenAt: T1 }),
      rec({ lemma: 'only-local', status: 'unknown', lastSeenAt: T0 }),
    ]
    const remote = [
      rec({ lemma: 'apple', status: 'unknown', lastSeenAt: T1, seenCount: 2 }),
      rec({ lemma: 'fig', status: 'unsure', lastSeenAt: T1 }),
    ]

    const first = mergeWordStates(local, remote)

    // push 하면 서버는 "push 대상만 갈아끼운" 상태가 된다.
    // 이걸 흉내 내야 반복 동기화가 진짜와 같은 입력을 받는다.
    const keyOf = (r: WordStateRecord) => `${r.languageCode}::${r.lemma}`
    const pushed = new Set(first.pushOnly.map(keyOf))
    const serverAfterPush = [
      ...remote.filter((r) => !pushed.has(keyOf(r))),
      ...first.pushOnly,
    ]

    const second = mergeWordStates(first.merged, serverAfterPush)
    const third = mergeWordStates(second.merged, serverAfterPush)

    expect(second.pushOnly).toEqual([])
    expect(third.pushOnly).toEqual([])
    expect(second.merged).toEqual(first.merged)
    expect(third.merged).toEqual(first.merged)
  })

  it('빈 입력에도 죽지 않는다', () => {
    expect(mergeWordStates([], [])).toEqual({ merged: [], pushOnly: [], pullOnly: [] })
  })

  it('빈 쪽이 한쪽뿐이어도 모든 항목이 살아 있다', () => {
    const local = [rec({ lemma: 'a' }), rec({ lemma: 'b' })]
    expect(mergeWordStates(local, []).merged).toHaveLength(2)
    expect(mergeWordStates([], local).merged).toHaveLength(2)
  })
})

describe('mergeLanguages', () => {
  it('합집합을 낸다', () => {
    expect(mergeLanguages(['en', 'ko'], ['ko', 'ja'])).toEqual(['en', 'ko', 'ja'])
  })

  it('중복은 한 번만', () => {
    expect(mergeLanguages(['en'], ['en'])).toEqual(['en'])
  })

  it('서버에서 지우지 않는다 — 이 기기에서 지웠다고 다른 기기도 지워지면 안 된다', () => {
    expect(mergeLanguages([], ['ja'])).toEqual(['ja'])
  })
})
