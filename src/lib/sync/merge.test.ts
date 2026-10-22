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
    starAngle: 0,
    starColor: '#eab308',
    knownPresses: 0,
    unsurePresses: 0,
    unknownPresses: 0,
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
    const { pushOnly, pullOnly } = mergeWordStates([rec({ lemma: 'apple', status: 'known' })], [])
    expect(pushOnly.map((r) => r.lemma)).toEqual(['apple'])
    expect(pullOnly).toEqual([])
  })

  it('상태 없는 행은 서버에 없어도 보내지 않는다 — 지울 것이 없다', () => {
    const { pushOnly, pullOnly } = mergeWordStates([rec({ lemma: 'apple' })], [])
    expect(pushOnly).toEqual([])
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

/**
 * 표시를 없애면 서버 행도 지워진다.
 *
 * 없앤 것을 upsert 하면 NOT NULL 없는 상태가 'unsure' 로 굳어져, 없앴는데
 * 모름으로 되살아난다. 그래서 상태 없는 행은 push 에서 지우기로 간다.
 * 반대로 서버에만 있는 행은 건드리지 않는다 — 본 적 없는 단어를 지울 수는 없다.
 */
describe('mergeWordStates — 표시 없애기', () => {
  it('늦게 없앤 쪽이 이긴다 — 상태가 달라도 시각이 답이다', () => {
    const local = [rec({ lemma: 'apple', lastSeenAt: T2 })] // 상태 없음 = 없앰
    const remote = [rec({ lemma: 'apple', status: 'known', lastSeenAt: T1 })]
    const { merged, pushOnly } = mergeWordStates(local, remote)
    expect(find(merged, 'apple')?.status).toBeUndefined()
    // 지우라고 서버에 알려야 한다
    expect(pushOnly.map((r) => r.lemma)).toEqual(['apple'])
    expect(pushOnly[0]?.status).toBeUndefined()
  })

  it('옛날에 없앤 것은 서버가 이긴다 — 늦게 표시한 쪽이 정답이다', () => {
    const local = [rec({ lemma: 'apple', lastSeenAt: T1 })]
    const remote = [rec({ lemma: 'apple', status: 'known', lastSeenAt: T2 })]
    const { merged } = mergeWordStates(local, remote)
    expect(find(merged, 'apple')?.status).toBe('known')
  })

  it('지운 뒤에는 조용하다 — 매번 지우기를 보내지 않는다', () => {
    // 서버에 행이 없는데 로컬에만 상태 없는 행: 보낼 것도 지울 것도 없다
    const { pushOnly } = mergeWordStates([rec({ lemma: 'apple' })], [])
    expect(pushOnly).toEqual([])
  })

  it('상태를 비웠어도 기록이 있으면 서버에 남긴다 — 행이 곧 기록의 자리다', () => {
    const local = [
      rec({
        lemma: 'apple',
        favorite: true,
        favoriteUpdatedAt: T2,
        note: '기억',
        noteUpdatedAt: T2,
      }),
    ]
    const { pushOnly } = mergeWordStates(local, [])
    expect(pushOnly.map((r) => r.lemma)).toEqual(['apple'])
    expect(pushOnly[0]?.status).toBeUndefined()
  })

  it('별은 없애도 남는다 — 상태만 빠지고 행은 산다', () => {
    const local = [
      rec({ lemma: 'apple', lastSeenAt: T2, favorite: true, favoriteUpdatedAt: T2 }),
    ]
    const remote = [
      rec({ lemma: 'apple', status: 'known', lastSeenAt: T1, favorite: false, favoriteUpdatedAt: T1 }),
    ]
    const merged = find(mergeWordStates(local, remote).merged, 'apple')
    expect(merged?.status).toBeUndefined()
    expect(merged?.favorite).toBe(true)
  })
})

describe('mergeWordStates — 합성 필드', () => {
  it('seen_count 는 큰 값 — 같은 값을 여러 번 합치면 숫자가 불어난다', () => {
    const local = [rec({ lemma: 'apple', seenCount: 3 })]
    const remote = [rec({ lemma: 'apple', seenCount: 7 })]
    expect(find(mergeWordStates(local, remote).merged, 'apple')?.seenCount).toBe(7)
  })

  /**
   * 단추 누른 횟수도 seen_count 와 같은 규칙(큰 값)으로 합친다.
   *
   * 두 기기에서 각각 누른 것은 정확히 더해지지 않는다 — 지금의 병합 모델이
   * '큰 값' 이기 때문이다. 셈을 정확히 하려면 기기별 증분을 따로 들고 다녀야
   * 하는데, 그것은 지금 필요로 하는 것보다 큰 변화다.
   */
  it('단추 누른 횟수는 항목마다 큰 값으로 합친다', () => {
    const local = [rec({ lemma: 'apple', knownPresses: 3, unsurePresses: 1 })]
    const remote = [rec({ lemma: 'apple', knownPresses: 5, unknownPresses: 2 })]
    const merged = find(mergeWordStates(local, remote).merged, 'apple')
    expect(merged?.knownPresses).toBe(5)
    expect(merged?.unsurePresses).toBe(1)
    expect(merged?.unknownPresses).toBe(2)
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

  /** 꾸밈은 별의 시각을 이긴 쪽의 것을 함께 쓴다 — 별과 따로 겨루면 기울기만 다른 별이 된다 */
  it('별의 기울기와 색은 별을 이긴 쪽을 따라간다', () => {    const local = [
      rec({
        lemma: 'apple',
        favorite: false,
        favoriteUpdatedAt: T2,
        starAngle: 10,
        starColor: '#ef4444',
      }),
    ]
    const remote = [
      rec({
        lemma: 'apple',
        favorite: true,
        favoriteUpdatedAt: T1,
        starAngle: -20,
        starColor: '#3b82f6',
      }),
    ]
    const merged = find(mergeWordStates(local, remote).merged, 'apple')
    expect(merged?.favorite).toBe(false)
    expect(merged?.starAngle).toBe(10)
    expect(merged?.starColor).toBe('#ef4444')
  })
})

/**
 * 메모도 자기 시각으로만 겨룬다 — 별과 같은 이유다. '고친 적 없음' 과
 * '비웠음' 을 구분해야 상태만 바꾼 기기가 메모를 지우지 않는다.
 */
describe('mergeWordStates — 메모', () => {
  it('메모를 늦게 고친 쪽이 이긴다', () => {
    const local = [rec({ lemma: 'apple', note: 'old', noteUpdatedAt: T1 })]
    const remote = [rec({ lemma: 'apple', note: 'new', noteUpdatedAt: T2 })]
    expect(find(mergeWordStates(local, remote).merged, 'apple')?.note).toBe('new')
  })

  it('상태만 바꾼 기기가 다른 기기의 메모를 지우지 않는다', () => {
    // 서버 행은 메모를 고친 적이 없다 (noteUpdatedAt 없음) — lastSeenAt 이 더 늦어도
    // 메모는 메모를 적은 쪽이 남아야 한다
    const local = [rec({ lemma: 'apple', note: 'mine', noteUpdatedAt: T1 })]
    const remote = [rec({ lemma: 'apple', lastSeenAt: T2 })]
    expect(find(mergeWordStates(local, remote).merged, 'apple')?.note).toBe('mine')
  })

  it('메모를 비운 것도 늦으면 이긴다', () => {
    const local = [rec({ lemma: 'apple', noteUpdatedAt: T2 })]
    const remote = [rec({ lemma: 'apple', note: 'old', noteUpdatedAt: T1 })]
    expect(find(mergeWordStates(local, remote).merged, 'apple')?.note).toBeUndefined()
  })

  it('메모만 바뀌어도 서버에 보낸다', () => {
    const local = [rec({ lemma: 'apple', status: 'known', note: 'mine', noteUpdatedAt: T2 })]
    const remote = [rec({ lemma: 'apple', status: 'known', note: 'theirs', noteUpdatedAt: T1 })]
    const { pushOnly } = mergeWordStates(local, remote)
    expect(pushOnly).toHaveLength(1)
    expect(pushOnly[0]?.note).toBe('mine')
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
