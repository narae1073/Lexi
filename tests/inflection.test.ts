import { describe, expect, it } from 'vitest'

import {
  isFormOf,
  lookupCandidates,
  referencedHeadwords,
} from '../supabase/functions/_shared/inflection'

/** 테스트에서 쓰기 편하게 단어 배열로 바꾼다 */
const words = (lang: string, word: string) => lookupCandidates(lang, word).map((c) => c.word)
/** via 가 'inflection' 인 후보만 — 기본형으로 신뢰할 수 있는 것 */
const bases = (lang: string, word: string) =>
  lookupCandidates(lang, word).filter((c) => c.via === 'inflection').map((c) => c.word)

describe('한국어 활용형 후보', () => {
  it('속는다 → 속다 를 찾는다', () => {
    expect(words('ko', '속는다')).toContain('속다')
  })

  it('읽습니다 → 읽다 를 찾는다', () => {
    expect(words('ko', '읽습니다')).toContain('읽다')
  })

  it('했습니다 → 했다 (규칙 활용)', () => {
    expect(words('ko', '했습니다')).toContain('했다')
  })

  // 아래 두 개는 불규칙 활용이라 접미사 절단으로는 복원이 불가능하다.
  // 좋아합니다 → 좋아하다 (ㅎ불규칙), 갑니다 → 가다 (ㄷ불규칙)
  // 형태소 분석기가 없으면 계속 404 다. 사전을 조용히 틀린 뜻으로 보여주는 것보다 낫다.
  it('불규칙 활용은 복원하지 못한다 (알려진 한계)', () => {
    expect(words('ko', '좋아합니다')).not.toContain('좋아하다')
    expect(words('ko', '갑니다')).not.toContain('가다')
  })

  it('불규칙 활용에서도 후보는 어설프게나마 생성된다', () => {
    expect(words('ko', '좋아합니다').length).toBeGreaterThan(1)
  })

  it('복수 접미사 을 벗겨낸다', () => {
    expect(words('ko', '학생들')).toContain('학생')
  })

  it('이미 기본형이면 그대로 두고 조각을 붙이지 않는다', () => {
    const candidates = words('ko', '가다')
    expect(candidates[0]).toBe('가다')
    expect(candidates).not.toContain('다')
  })
})

describe('영문 활용 후보', () => {
  it('현재형을 원형으로 되돌린다', () => {
    expect(words('en', 'running')).toContain('run')
  })

  it('과거형에서 어간을 얻는다', () => {
    expect(words('en', 'changed')).toContain('chang')
  })

  it('불규칙 변화는 못 잡아도 된다', () => {
    expect(words('en', 'ran')).not.toContain('run')
  })

  it('짧은 단어에서 어간을 잘라내지 않는다', () => {
    expect(words('en', 'bed')).not.toContain('b')
    expect(words('en', 'goes')).not.toContain('go')
  })
})

describe('후보 열거 규칙', () => {
  it('원형이 항상 첫 번째다', () => {
    expect(words('ko', '속는다')[0]).toBe('속는다')
  })

  it('중복을 제거한다', () => {
    for (const lang of ['ko', 'en']) {
      const c = words(lang, 'aaa')
      expect(new Set(c).size).toBe(c.length)
    }
  })

  it('상한을 넘지 않는다', () => {
    expect(lookupCandidates('ko', '가나다라마바사아자차카타파하', 3).length).toBeLessThanOrEqual(3)
  })

  it('미지원 언어는 원형만 돌려준다', () => {
    expect(words('ja', 'ischeru')).toEqual(['ischeru'])
    expect(words('fr', 'manger')).toEqual(['manger'])
  })

  it('빈 입력도 안전하다', () => {
    expect(words('ko', '')).toEqual([''])
  })
})
describe('후보 출처(via)', () => {
  it('원형은 exact, 파생 후보는 inflection 이다', () => {
    const candidates = lookupCandidates('en', 'running')
    expect(candidates[0]).toEqual({ word: 'running', via: 'exact' })
    expect(candidates.filter((c) => c.via === 'inflection').map((c) => c.word)).toContain('run')
  })

  it('독일어는 대소문자만 다루므로 inflection 후보가 없다', () => {
    // 대소문자는 표기를 보존해 조회하는 쪽이 책임진다 — 여기서 만들면
    // de/Haus 가 동사 haus 로 잘못 연결된다
    expect(bases('de', 'Haus')).toEqual([])
  })

  it('영어 대문자 표기도 inflection 후보를 갖는다 (형태는 보존된다)', () => {
    expect(bases('en', 'Haus')).not.toContain('hau')
    expect(lookupCandidates('en', 'Haus')[0].via).toBe('exact')
  })
})

// 실제 위키낱말 응답에서 온 케이스 (2026-10 실측)
describe('원형어 추출 — 실측 데이터', () => {
  it('독일어: 콜론이 붙은 "inflection of leben:" 에서 leben 을 뽑는다', () => {
    // 이 콜론 때문에 예전엔 "leben:" 을 그대로 조회해 원형을 놓쳤다
    expect(
      referencedHeadwords([{ definition: 'inflection of leben:', tags: [] }]),
    ).toContain('leben')
  })

  it('스페인어: 하이픈 붙은 "third-person ... of mirar" 에서 mirar 를 뽑는다', () => {
    expect(
      referencedHeadwords([
        {
          definition:
            'first/third-person singular imperfect indicative of mirar',
          tags: ['first person', 'form of', 'imperfect', 'indicative', 'singular', 'third person'],
        },
      ]),
    ).toContain('mirar')
  })

  it('프랑스어: "chantait" → chanter', () => {
    expect(
      referencedHeadwords([
        {
          definition: 'third-person singular imperfect indicative of chanter',
          tags: ['form of', 'imperfect', 'indicative', 'singular', 'third person'],
        },
      ]),
    ).toContain('chanter')
  })

  it('영어: "present participle and gerund of run" → run', () => {
    expect(
      referencedHeadwords([{ definition: 'present participle and gerund of run', tags: ['form of'] }]),
    ).toContain('run')
  })

  it('한국어: 원형이 그대로 적힌 항목', () => {
    expect(
      referencedHeadwords([{ definition: 'past of 간다', tags: ['form of'] }]),
    ).toContain('간다')
  })

  it('마침표로 끝나도 뽑는다', () => {
    expect(referencedHeadwords([{ definition: 'plural of Kinder.', tags: ['form of'] }])).toContain(
      'Kinder',
    )
  })

  it('원형어가 정의 중간에 있어도 잡는다 (뒤에 설명이 붙는 경우)', () => {
    // de/waren = "first/third-person plural preterite of sein: were"
    expect(
      referencedHeadwords([
        {
          definition: 'first/third-person plural preterite of sein: were',
          tags: ['first person', 'form of', 'plural', 'preterite', 'third person'],
        },
      ]),
    ).toContain('sein')
    // de/war = "first-person singular preterite of sein:"
    expect(
      referencedHeadwords([
        { definition: 'first-person singular preterite of sein:', tags: ['form of'] },
      ]),
    ).toContain('sein')
    // de/bin = "first-person singular present of sein"
    expect(
      referencedHeadwords([{ definition: 'first-person singular present of sein', tags: ['form of'] }]),
    ).toContain('sein')
  })

  it('일반 뜻에서는 원형어를 지어내지 않는다 (오탐 방지)', () => {
    // "a kind of X" 같은 표현은 활용 설명이 아니므로 건드리면 안 된다
    expect(referencedHeadwords([{ definition: 'a kind of wood', tags: [] }])).toEqual([])
    expect(referencedHeadwords([{ definition: '(uncountable) wood (material)', tags: ['uncountable'] }])).toEqual([])
    expect(referencedHeadwords([{ definition: 'Present, current.', tags: ['not comparable'] }])).toEqual([])
  })

  it('정의가 없거나 빈 값이면 무시한다', () => {
    expect(referencedHeadwords([{ definition: '', tags: ['form of'] }])).toEqual([])
    expect(referencedHeadwords([{ tags: ['form of'] }])).toEqual([])
    expect(referencedHeadwords(undefined)).toEqual([])
  })

  it('한 항목에 여러 원형어가 나올 수 있어도 중복을 없앤다', () => {
    const out = referencedHeadwords([
      { definition: 'inflection of leben:', tags: [] },
      { definition: 'inflection of leben:', tags: [] },
    ])
    expect(out).toEqual(['leben'])
  })
})

describe('isFormOf', () => {
  it("'form of' 태그를 판별한다", () => {
    expect(isFormOf(['form of', 'imperfect'])).toBe(true)
    expect(isFormOf(['not comparable'])).toBe(false)
    expect(isFormOf(undefined)).toBe(false)
  })
})
