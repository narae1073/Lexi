import { describe, expect, it } from 'vitest'

import { isNewer, mergeWordStates, withStatus, type WordStateRecord } from './merge'

/** 서버(Postgres timestamptz) 가 주는 모양 */
const SERVER_TIME = '2026-10-04T21:00:00+00:00'
/** 이 기기가 저장하는 모양 */
const LOCAL_TIME = '2026-10-04T21:00:00.000Z'

const record = (over: Partial<WordStateRecord> = {}): WordStateRecord => ({
  languageCode: 'fr',
  lemma: 'été',
  status: 'known',
  seenCount: 1,
  firstSeenAt: LOCAL_TIME,
  lastSeenAt: LOCAL_TIME,
  favorite: false,
  favoriteUpdatedAt: LOCAL_TIME,
  starAngle: 0,
  starColor: '#eab308',
  ...over,
})

/**
 * 시각 비교는 형식과 무관해야 한다.
 *
 * 회귀: 문자열로 비교했다. 같은 시각인데 이 기기는 `...00.000Z`, 서버는 `...00+00:00`
 * 를 준다 — 같은 자리에서 `.`(0x2E)와 `+`(0x2B)가 갈라지므로 **형식에 따라 어느 쪽이
 * 이기는지가 뒤집힌다.** 서버가 더 늦다고 잘못 판단되면 그 기기에서 사용자가 고른 상태가
 * 조용히 사라진다.
 */
describe('시각 표기가 섞여도 같다', () => {
  it('같은 시각은 어느 쪽도 더 늦지 않다', () => {
    expect(isNewer(LOCAL_TIME, SERVER_TIME)).toBe(false)
    expect(isNewer(SERVER_TIME, LOCAL_TIME)).toBe(false)
  })

  it('실제로 늦은 쪽이 이긴다', () => {
    expect(isNewer('2026-10-04T22:00:00.000Z', SERVER_TIME)).toBe(true)
    expect(isNewer(SERVER_TIME, '2026-10-04T20:00:00.000Z')).toBe(true)
  })

  it('오프셋이 붙어도 시각으로 판단한다', () => {
    // 09:00+09:00 는 00:00Z 와 같은 시각이다
    expect(isNewer('2026-10-04T00:00:00.000Z', '2026-10-04T09:00:00+09:00')).toBe(false)
    expect(isNewer('2026-10-04T01:00:00.000Z', '2026-10-04T09:00:00+09:00')).toBe(true)
  })

  /**
   * 해석할 수 없으면 '더 늦지 않다' 고 본다.
   *
   * 이쪽이 지는 쪽이므로 해석 실패는 서버로 보내는 쪽으로 흐른다 — 기기 안에만 남는
   * 쪽이 아니다. 모르는 것을 알고 있다고 말하지 않는다.
   */
  it('해석할 수 없으면 더 늦지 않다 — 기기 안에만 남지 않게', () => {
    expect(isNewer('형식이 아님', LOCAL_TIME)).toBe(false)
    expect(isNewer(LOCAL_TIME, '형식이 아님')).toBe(false)
    expect(isNewer('형식이 아님', '역시 아님')).toBe(false)
  })
})

describe('사용자가 고른 상태가 서버에 지지 않는다', () => {
  it('이 기기가 더 늦게 고른 상태가 이긴다', () => {
    const local = record({ status: 'known', lastSeenAt: '2026-10-04T22:00:00.000Z' })
    const remote = record({ status: 'unsure', lastSeenAt: SERVER_TIME })

    const { merged, pushOnly } = mergeWordStates([local], [remote])
    expect(merged[0].status).toBe('known')
    expect(pushOnly.map((r) => r.lemma)).toEqual(['été'])
  })

  /**
   * 핵심 사례 — 기기마다 진도가 다른 증상.
   *
   * 서버의 행이 이 기기의 시각표기와 형식이 달라도, **이 기기가 실제로 더 늦게 고른
   * 상태는 서버에 나가야 한다.** 형식 때문에 밀리면 '이 기기만 최신이고 나머지는 옛것' 이
   * 되어 사용자는 무엇을 해도 고칠 수 없다.
   */
  it('형식이 달라도 이 기기의 변경이 밀리지 않는다', () => {
    const local = record({ status: 'known', lastSeenAt: '2026-10-05T00:00:00.000Z' })
    const remote = record({ status: 'unsure', lastSeenAt: SERVER_TIME })

    const { pushOnly } = mergeWordStates([local], [remote])
    expect(pushOnly).toHaveLength(1)
    expect(withStatus(pushOnly[0]).status).toBe('known')
  })

  it('서버가 더 늦게 고른 상태는 서버가 이긴다 — 다른 기기의 일을 덮지 않는다', () => {
    const local = record({ status: 'unsure', lastSeenAt: '2026-10-04T20:00:00.000Z' })
    const remote = record({ status: 'known', lastSeenAt: '2026-10-04T22:00:00+00:00' })

    const { merged, pushOnly } = mergeWordStates([local], [remote])
    expect(merged[0].status).toBe('known')
    expect(pushOnly).toHaveLength(0)
  })

  it('서버와 같으면 다시 보내지 않는다 — 무한 갱신을 막는다', () => {
    const a = record({ lastSeenAt: LOCAL_TIME })
    const { pushOnly } = mergeWordStates([a], [{ ...a }])
    expect(pushOnly).toHaveLength(0)
  })

  it('처음 보는 단어는 보낸다', () => {
    const { pushOnly } = mergeWordStates([record()], [])
    expect(pushOnly).toHaveLength(1)
  })

  it('서버에만 있는 단어는 받아 온다', () => {
    const { pullOnly } = mergeWordStates([], [record({ lemma: 'chat' })])
    expect(pullOnly).toHaveLength(1)
  })

  it('earliest 는 시각으로 고른다 — 형식이 섞여도 이른 쪽이 이긴다', () => {
    const local = record({ firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-05T00:00:00.000Z' })
    const remote = record({ firstSeenAt: '2026-09-01T00:00:00+00:00', lastSeenAt: SERVER_TIME })

    const { merged } = mergeWordStates([local], [remote])
    expect(merged[0].firstSeenAt).toBe('2026-09-01T00:00:00+00:00')
  })
})