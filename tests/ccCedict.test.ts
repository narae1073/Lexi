import { describe, expect, it } from 'vitest'

import { parseCedictLine, pinyinToneMarks } from '../supabase/functions/_shared/ccCedict'

describe('parseCedictLine', () => {
  it('기본 행을 파싱한다', () => {
    expect(
      parseCedictLine('北京大學 北京大学 [Bei3 jing1 Da4 xue2] /Peking University/'),
    ).toEqual({
      traditional: '北京大學',
      simplified: '北京大学',
      pinyin: 'Bei3 jing1 Da4 xue2',
      glosses: ['Peking University'],
    })
  })

  it('뜻이 여러 개면 나눈다', () => {
    const entry = parseCedictLine(
      '愛 爱 [ai4] /to love; to be fond of; to like/affection/to be inclined (to do sth)/',
    )
    expect(entry?.glosses).toEqual([
      'to love; to be fond of; to like',
      'affection',
      'to be inclined (to do sth)',
    ])
  })

  it('주석·빈 줄·깨진 줄은 null — 한 줄이 전체 적재를 죽이지 않는다', () => {
    expect(parseCedictLine('# CC-CEDICT')).toBeNull()
    expect(parseCedictLine('')).toBeNull()
    expect(parseCedictLine('   ')).toBeNull()
    expect(parseCedictLine('깨진 줄')).toBeNull()
    expect(parseCedictLine('北京大學 北京大学 /뜻만 있음/')).toBeNull()
  })
})

describe('pinyinToneMarks', () => {
  it('기본 변환', () => {
    expect(pinyinToneMarks('Bei3 jing1 Da4 xue2')).toBe('Běi jīng Dà xué')
    expect(pinyinToneMarks('ni3 hao3')).toBe('nǐ hǎo')
  })

  it('u: 는 ü 다', () => {
    expect(pinyinToneMarks('lu:4')).toBe('lǜ')
    expect(pinyinToneMarks('nu:3')).toBe('nǚ')
  })

  it('5성·무표기는 숫자만 뗀다', () => {
    expect(pinyinToneMarks('le5')).toBe('le')
    expect(pinyinToneMarks('de')).toBe('de')
  })

  it('iu·ui 는 뒤 모음에 찍는다', () => {
    expect(pinyinToneMarks('liu2')).toBe('liú')
    expect(pinyinToneMarks('gui4')).toBe('guì')
    expect(pinyinToneMarks('xiu1')).toBe('xiū')
  })

  it('a·o·e 우선순위', () => {
    expect(pinyinToneMarks('ai4')).toBe('ài')
    expect(pinyinToneMarks('gou3')).toBe('gǒu')
    expect(pinyinToneMarks('ye4')).toBe('yè')
  })

  it('대소문자를 지킨다', () => {
    expect(pinyinToneMarks('Zhong1 wen2')).toBe('Zhōng wén')
  })
})
