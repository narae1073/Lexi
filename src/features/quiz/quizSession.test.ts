import { describe, expect, it } from 'vitest'

import type { WordStatus } from '../../types'
import {
  drawWords,
  nextStatus,
  quizPool,
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
) => ({ lemma, surfaces, status, sentence })

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
})

describe('단어 뽑기', () => {
  const pool: QuizWord[] = ['a', 'b', 'c', 'd', 'e'].map((lemma, i) => ({
    lemma,
    surface: lemma,
    status: i < 2 ? 'unsure' : 'unknown',
    sentence: `${lemma} appears here.`,
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
