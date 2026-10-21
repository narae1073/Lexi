import { describe, expect, it } from 'vitest'

import type { WordStatus } from '../../types'
import {
  DAY_MS,
  blankWord,
  defaultSessionSize,
  drawWords,
  isDue,
  nextStatus,
  quizPool,
  reviewIntervalMs,
  reviewPool,
  selectSession,
  sessionChanges,
  sessionSizeOptions,
  summarize,
  type QuizWord,
} from './quizSession'

/** 퀴즈 진입에 쓰는 최소 모양 — 단어장 항목(WordbookEntry)이 그대로 만족한다 */
const entry = (
  lemma: string,
  status: WordStatus | 'unmarked',
  surfaces: string[] = [lemma],
  sentence = '',
  documentTitle = '',
) => ({ lemma, surfaces, status, sentence, documentTitle })

describe('상태 전이표', () => {
  /**
   * 표의 한가운데가 규칙이다: '모름' 인 단어는 곧바로 '앎' 이 될 수 없다.
   * 눌러도 '헷갈림' 에 머문다 — 한 번에 건너뛰는 길을 막는 것이 요점이다.
   */
  it('모름에서 앎을 누르면 헷갈림이 된다 — 건너뛸 수 없다', () => {
    expect(nextStatus('unknown', 'known')).toBe('unsure')
  })

  it('나머지 칸은 누른 그대로가 된다', () => {
    const cases: [WordStatus, WordStatus, WordStatus][] = [
      ['known', 'known', 'known'],
      ['known', 'unsure', 'unsure'],
      ['known', 'unknown', 'unknown'],
      ['unsure', 'known', 'known'],
      ['unsure', 'unsure', 'unsure'],
      ['unsure', 'unknown', 'unknown'],
      ['unknown', 'unsure', 'unsure'],
      ['unknown', 'unknown', 'unknown'],
    ]
    for (const [prev, pressed, expected] of cases) {
      expect(nextStatus(prev, pressed)).toBe(expected)
    }
  })

  it('헷갈림에서 앎은 곧바로 된다 — 모름과 다르다', () => {
    expect(nextStatus('unsure', 'known')).toBe('known')
  })
})

describe('세션 크기 선택지', () => {
  it('10 의 배수로 100 까지 낸다', () => {
    expect(sessionSizeOptions(100)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  })

  it('가진 단어 수를 넘는 선택지는 내지 않는다', () => {
    expect(sessionSizeOptions(45)).toEqual([10, 20, 30, 40])
  })

  it('10 개도 안 되면 가진 만큼만 낼 수 있다', () => {
    expect(sessionSizeOptions(7)).toEqual([7])
  })

  it('낼 단어가 없으면 선택지도 없다', () => {
    expect(sessionSizeOptions(0)).toEqual([])
  })
})

describe('퀴즈에 낼 단어 고르기', () => {
  it('헷갈림과 모름만 낸다 — 앎과 미표시는 뺀다', () => {
    const pool = quizPool([
      entry('alpha', 'unsure'),
      entry('beta', 'unknown'),
      entry('gamma', 'known'),
      entry('delta', 'unmarked'),
    ])
    expect(pool.map((w) => w.lemma)).toEqual(['alpha', 'beta'])
  })

  it('낼 상태를 함께 들고 있다', () => {
    const pool = quizPool([entry('alpha', 'unsure')])
    expect(pool[0].status).toBe('unsure')
  })

  it('보여 줄 표기는 실제 쓰인 표기를 쓴다', () => {
    const pool = quizPool([entry('us', 'unsure', ['US', 'us'])])
    expect(pool[0].surface).toBe('US')
  })

  it('표기가 없으면 기본형을 보여 준다', () => {
    const pool = quizPool([entry('alpha', 'unknown', [])])
    expect(pool[0].surface).toBe('alpha')
  })

  it('예문을 함께 들고 있다 — 답한 뒤 문맥을 보여 주려고', () => {
    const pool = quizPool([entry('alpha', 'unsure', ['alpha'], 'Alpha is the first letter.')])
    expect(pool[0].sentence).toBe('Alpha is the first letter.')
  })

  it('출처 문서 제목을 함께 들고 있다 — 예문이 어디서 왔는지 보여 주려고', () => {
    const pool = quizPool([
      entry('alpha', 'unsure', ['alpha'], 'Alpha is first.', 'My Notes'),
    ])
    expect(pool[0].documentTitle).toBe('My Notes')
  })

  it('문맥과 복습 정보를 함께 들고 있다', () => {
    const pool = quizPool([
      {
        ...entry('alpha', 'unsure'),
        contexts: [{ sentence: 'Alpha is first.', documentTitle: 'Notes' }],
        lastSeenAt: '2026-10-01T00:00:00.000Z',
        knownPresses: 2,
      },
    ])
    expect(pool[0].contexts).toHaveLength(1)
    expect(pool[0].lastSeenAt).toBe('2026-10-01T00:00:00.000Z')
    expect(pool[0].knownPresses).toBe(2)
  })
})

describe('기본 개수', () => {
  it('50 이 있으면 50 을 쓴다', () => {
    expect(defaultSessionSize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(50)
  })

  it('가진 것이 50 미만이면 그 안에서 가장 큰 것을 쓴다', () => {
    expect(defaultSessionSize([10, 20, 30, 40])).toBe(40)
  })

  it('50 만 있어도 50 을 쓴다', () => {
    expect(defaultSessionSize([50])).toBe(50)
  })

  it('낼 단어가 없으면 null 이다', () => {
    expect(defaultSessionSize([])).toBeNull()
  })
})

describe('단어 뽑기', () => {
  const pool: QuizWord[] = ['a', 'b', 'c', 'd', 'e'].map((lemma, i) => ({
    lemma,
    surface: lemma,
    status: i < 2 ? 'unsure' : 'unknown',
    sentence: `${lemma} appears here.`,
    documentTitle: 'Notes',
  }))

  it('요청한 개수만큼 뽑는다', () => {
    expect(drawWords(pool, 3, () => 0.5)).toHaveLength(3)
  })

  it('같은 단어를 두 번 내지 않는다', () => {
    const drawn = drawWords(pool, 5, mulberry(1))
    expect(new Set(drawn.map((w) => w.lemma)).size).toBe(5)
  })

  it('가진 것보다 많이 요청하면 가진 것을 모두 낸다', () => {
    expect(drawWords(pool, 99, () => 0.3)).toHaveLength(5)
  })

  it('난수를 그대로 따르므로 결과가 재현된다', () => {
    const first = drawWords(pool, 3, mulberry(42)).map((w) => w.lemma)
    const second = drawWords(pool, 3, mulberry(42)).map((w) => w.lemma)
    expect(first).toEqual(second)
  })

  it('원래 목록을 건드리지 않는다', () => {
    const before = pool.map((w) => w.lemma)
    drawWords(pool, 3, mulberry(7))
    expect(pool.map((w) => w.lemma)).toEqual(before)
  })
})

describe('복습 간격', () => {
  const now = Date.parse('2026-10-21T00:00:00.000Z')
  const daysAgo = (days: number) => new Date(now - days * DAY_MS).toISOString()

  it('모름은 하루, 헷갈림은 사흘, 앎은 일주일', () => {
    expect(reviewIntervalMs('unknown')).toBe(DAY_MS)
    expect(reviewIntervalMs('unsure')).toBe(3 * DAY_MS)
    expect(reviewIntervalMs('known')).toBe(7 * DAY_MS)
  })

  it('앎을 세 번 이상 누른 단어는 21일로 벌린다', () => {
    expect(reviewIntervalMs('known', 2)).toBe(7 * DAY_MS)
    expect(reviewIntervalMs('known', 3)).toBe(21 * DAY_MS)
  })

  it('기한이 지났을 때만 다시 본다', () => {
    expect(isDue({ status: 'unknown', lastSeenAt: daysAgo(2) }, now)).toBe(true)
    expect(isDue({ status: 'unsure', lastSeenAt: daysAgo(2) }, now)).toBe(false)
    expect(isDue({ status: 'unsure', lastSeenAt: daysAgo(4) }, now)).toBe(true)
    expect(isDue({ status: 'known', lastSeenAt: daysAgo(6) }, now)).toBe(false)
    expect(isDue({ status: 'known', lastSeenAt: daysAgo(8) }, now)).toBe(true)
    expect(isDue({ status: 'known', lastSeenAt: daysAgo(22), knownPresses: 3 }, now)).toBe(true)
  })

  it('시각이 없거나 깨졌으면 한 번 더 본다', () => {
    expect(isDue({ status: 'known' }, now)).toBe(true)
    expect(isDue({ status: 'known', lastSeenAt: 'not-a-date' }, now)).toBe(true)
  })

  it('기한이 된 앎만 복습 재료로 고른다', () => {
    const entries = [
      entry('old', 'known'),
      entry('fresh', 'known'),
      entry('unsure', 'unsure'),
    ].map((e) => ({
      ...e,
      lastSeenAt: e.lemma === 'fresh' ? daysAgo(1) : daysAgo(30),
      knownPresses: 0,
    }))
    expect(reviewPool(entries, now).map((w) => w.lemma)).toEqual(['old'])
  })
})

describe('세션 단어 고르기', () => {
  const word = (lemma: string, status: WordStatus = 'unsure'): QuizWord => ({
    lemma,
    surface: lemma,
    status,
    sentence: '',
    documentTitle: '',
  })
  const pool = Array.from({ length: 20 }, (_, i) => word(`p${i}`))
  const reviews = Array.from({ length: 10 }, (_, i) => word(`k${i}`, 'known'))

  it('앎 복습은 세션의 20% 까지만 섞인다', () => {
    const picked = selectSession(pool, reviews, 10, mulberry(1))
    expect(picked).toHaveLength(10)
    expect(picked.filter((w) => w.status === 'known')).toHaveLength(2)
  })

  it('낼 것이 모자라면 남는 자리를 앎으로 채운다', () => {
    const picked = selectSession(pool.slice(0, 3), reviews, 10, mulberry(2))
    expect(picked).toHaveLength(10)
    expect(picked.filter((w) => w.status === 'unsure')).toHaveLength(3)
    expect(picked.filter((w) => w.status === 'known')).toHaveLength(7)
  })

  it('가진 것보다 많이 고르면 가진 것을 모두 낸다', () => {
    expect(selectSession(pool.slice(0, 2), reviews.slice(0, 1), 10, mulberry(3))).toHaveLength(3)
  })

  it('개수가 0 이면 아무것도 내지 않는다', () => {
    expect(selectSession(pool, reviews, 0)).toEqual([])
  })

  it('같은 단어를 두 번 내지 않는다', () => {
    const picked = selectSession(pool, reviews, 10, mulberry(4))
    expect(new Set(picked.map((w) => w.lemma)).size).toBe(10)
  })

  it('원래 목록을 건드리지 않는다', () => {
    const before = pool.map((w) => w.lemma)
    selectSession(pool, reviews, 10, mulberry(5))
    expect(pool.map((w) => w.lemma)).toEqual(before)
  })
})

describe('문맥 고르기', () => {
  it('뽑힌 단어마다 문맥 하나를 붙인다 — 원래 목록은 그대로', () => {
    const source: QuizWord = {
      lemma: 'cat',
      surface: 'cat',
      status: 'unsure',
      sentence: 'fallback',
      documentTitle: 'Fallback',
      contexts: [
        { sentence: 'The cat sat.', documentTitle: 'A' },
        { sentence: 'A cat ran.', documentTitle: 'B' },
      ],
    }
    const drawn = drawWords([source], 1, () => 0)
    expect(drawn[0].sentence).toBe('The cat sat.')
    expect(drawn[0].documentTitle).toBe('A')
    expect(source.sentence).toBe('fallback')
  })

  it('문맥이 없으면 원래 예문을 그대로 쓴다', () => {
    const source: QuizWord = {
      lemma: 'cat',
      surface: 'cat',
      status: 'unsure',
      sentence: 'Only one.',
      documentTitle: 'Doc',
    }
    expect(drawWords([source], 1, () => 0.9)[0].sentence).toBe('Only one.')
  })
})

describe('빈칸 만들기', () => {
  it('문장에 한 번 나오는 표기를 가린다', () => {
    expect(blankWord('The cat sat on the mat.', 'cat')).toBe('The ____ sat on the mat.')
  })

  it('두 번 나오면 어느 자리인지 알 수 없으므로 가리지 않는다', () => {
    expect(blankWord('The cat saw the cat.', 'cat')).toBeNull()
  })

  it('다른 낱말 속에만 나오면 가리지 않는다', () => {
    expect(blankWord('Concatenate the strings.', 'cat')).toBeNull()
  })

  it('문장에 없으면 가리지 않는다', () => {
    expect(blankWord('The cat sat.', 'dog')).toBeNull()
  })

  it('띄어쓰기가 없는 언어도 가린다', () => {
    expect(blankWord('私は猫が好きです。', '猫')).toBe('私は____が好きです。')
  })

  it('빈 문자열은 가리지 않는다', () => {
    expect(blankWord('', 'cat')).toBeNull()
    expect(blankWord('The cat sat.', '')).toBeNull()
  })
})

describe('세션 요약', () => {
  it('마친 상태별로 센다', () => {
    expect(summarize(['known', 'known', 'unsure', 'unknown'])).toEqual({
      known: 2,
      unsure: 1,
      unknown: 1,
    })
  })

  it('아무것도 없으면 모두 0 이다', () => {
    expect(summarize([])).toEqual({ known: 0, unsure: 0, unknown: 0 })
  })
})

describe('단어별 변화', () => {
  const words: QuizWord[] = [
    { lemma: 'a', surface: 'A', status: 'unknown', sentence: '', documentTitle: '' },
    { lemma: 'b', surface: 'b', status: 'unsure', sentence: '', documentTitle: '' },
    { lemma: 'c', surface: 'c', status: 'unknown', sentence: '', documentTitle: '' },
  ]

  it('푼 순서를 그대로 둔다 — 정렬하지 않는다', () => {
    const changes = sessionChanges(words, ['unsure', 'known', 'unknown'])
    expect(changes.map((c) => c.surface)).toEqual(['A', 'b', 'c'])
  })

  it('풀기 전과 후를 나란히 담는다', () => {
    const changes = sessionChanges(words, ['unsure', 'known', 'unknown'])
    expect(changes[0]).toEqual({ surface: 'A', before: 'unknown', after: 'unsure', changed: true })
    expect(changes[1]).toEqual({ surface: 'b', before: 'unsure', after: 'known', changed: true })
    expect(changes[2]).toEqual({ surface: 'c', before: 'unknown', after: 'unknown', changed: false })
  })

  it('답이 빠졌으면 풀기 전 상태로 둔다 — 부분 세션을 부수지 않는다', () => {
    const changes = sessionChanges(words, ['unsure'])
    expect(changes[1].after).toBe('unsure')
    expect(changes[1].changed).toBe(false)
    expect(changes[2].after).toBe('unknown')
    expect(changes[2].changed).toBe(false)
  })
})

/** 재현 가능한 난수 — 같은 씨앗이면 같은 순서가 나온다 (테스트가 흔들리지 않게) */
function mulberry(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
