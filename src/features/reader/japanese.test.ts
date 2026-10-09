import { describe, expect, it } from 'vitest'

import {
  byteToCharRanges,
  joinJapaneseMorphemes,
  toMorphemes,
  type JaMorpheme,
} from './japanese'

/**
 * lindera 없이 규칙만 시험한다 — 형태소 분석기는 무겁고 네트워크가 필요하므로
 * 단위 시험에 올리지 않는다. 실제 분절 품질은 e2e(28)에서 본다.
 */
const m = (
  surface: string,
  pos: string,
  sub1: string,
  baseForm: string,
  start: number,
  end: number,
): JaMorpheme => ({ surface, pos, sub1, baseForm, start, end })

describe('joinJapaneseMorphemes — 활용을 합친다', () => {
  it('食べ+た 는 한 단어, lemma 는 食べる', () => {
    const words = joinJapaneseMorphemes([
      m('食べ', '動詞', '自立', '食べる', 0, 2),
      m('た', '助動詞', '*', 'た', 2, 3),
    ])
    expect(words).toEqual([{ start: 0, end: 3, lemma: '食べる' }])
  })

  it('し+て+い+ます 는 食べて|います 로 — 接続助詞 て·で 는 활용의 일부다', () => {
    const words = joinJapaneseMorphemes([
      m('食べ', '動詞', '自立', '食べる', 0, 2),
      m('て', '助詞', '接続助詞', 'て', 2, 3),
      m('い', '動詞', '非自立', 'いる', 3, 4),
      m('ます', '助動詞', '*', 'ます', 4, 6),
    ])
    expect(words).toEqual([
      { start: 0, end: 3, lemma: '食べる' },
      { start: 3, end: 6, lemma: 'いる' },
    ])
  })

  it('格助詞は離しておく — 空港で の で は場所の 표시다', () => {
    const words = joinJapaneseMorphemes([
      m('空港', '名詞', '一般', '空港', 0, 2),
      m('で', '助詞', '格助詞', 'で', 2, 3),
    ])
    expect(words).toEqual([
      { start: 0, end: 2, lemma: '空港' },
      { start: 2, end: 3, lemma: 'で' },
    ])
  })

  it('조사는 단어로 남는다 — 조사도 학습 대상이다', () => {
    const words = joinJapaneseMorphemes([
      m('私', '名詞', '代名詞', '私', 0, 1),
      m('は', '助詞', '係助詞', 'は', 1, 2),
    ])
    expect(words).toEqual([
      { start: 0, end: 1, lemma: '私' },
      { start: 1, end: 2, lemma: 'は' },
    ])
  })

  it('접두사는 뒷 단어와 합치고 접미사는 앞 단어에 붙는다', () => {
    const words = joinJapaneseMorphemes([
      m('お', '接頭詞', '名詞接続', 'お', 0, 1),
      m('茶', '名詞', '一般', '茶', 1, 2),
      m('さん', '名詞', '接尾', 'さん', 2, 4),
    ])
    expect(words).toEqual([{ start: 0, end: 4, lemma: '茶' }])
  })

  it('구두점은 단어가 아니고 접두사의 기다림을 끊는다', () => {
    const words = joinJapaneseMorphemes([
      m('お', '接頭詞', '名詞接続', 'お', 0, 1),
      m('、', '記号', '読点', '、', 1, 2),
      m('茶', '名詞', '一般', '茶', 2, 3),
    ])
    expect(words).toEqual([
      { start: 0, end: 1, lemma: 'お' },
      { start: 2, end: 3, lemma: '茶' },
    ])
  })

  it('数字詞 + 接尾: 숫자는 단어가 아니고 年(접미)은 앞이 없으면 혼자 선다', () => {
    const words = joinJapaneseMorphemes([
      m('2026', 'UNK', '', '2026', 0, 4),
      m('年', '名詞', '接尾', '年', 4, 5),
    ])
    expect(words).toEqual([{ start: 4, end: 5, lemma: '年' }])
  })

  it('원형은 toMorphemes 가 채운다 — join 은 받은 것을 쓴다', () => {
    const words = joinJapaneseMorphemes([m('トートバッグ', '名詞', '一般', 'トートバッグ', 0, 6)])
    expect(words).toEqual([{ start: 0, end: 6, lemma: 'トートバッグ' }])
  })

  it('toMorphemes: 원형이 없으면(*) 표기를 쓰고 바이트를 문자로 바꾼다', () => {    const morphemes = toMorphemes('パン3個', [
      { surface: 'パン', baseForm: 'パン', partOfSpeech: '名詞', byteStart: 0, byteEnd: 6 },
      { surface: '3', baseForm: '*', partOfSpeech: 'UNK', byteStart: 6, byteEnd: 7 },
      { surface: '個', baseForm: '*', partOfSpeech: '名詞', byteStart: 7, byteEnd: 10 },
    ])
    expect(morphemes).toEqual([
      { surface: 'パン', baseForm: 'パン', pos: '名詞', sub1: '', start: 0, end: 2 },
      { surface: '3', baseForm: '3', pos: 'UNK', sub1: '', start: 2, end: 3 },
      { surface: '個', baseForm: '個', pos: '名詞', sub1: '', start: 3, end: 4 },
    ])
  })

  it('toMorphemes: 웹 빌드의 details 배열을 읽는다', () => {
    // 이름 붙은 getter(baseForm 등)는 node 빌드에만 있다. 브라우저에서는
    // details 배열로 온다 — 직접 필드를 읽으면 undefined 가 나와 합치기가
    // 전부 어긋난다. 실제로 그랬다.
    const morphemes = toMorphemes('食べた', [
      {
        surface: '食べ',
        details: ['動詞', '自立', '*', '*', '一段', '連用形', '食べる', 'タベ', 'タベ'],
        byte_start: 0,
        byte_end: 6,
      },
      {
        surface: 'た',
        details: ['助動詞', '*', '*', '*', '特殊・タ', '基本形', 'た', 'タ', 'タ'],
        byte_start: 6,
        byte_end: 9,
      },
    ])
    expect(morphemes).toEqual([
      { surface: '食べ', baseForm: '食べる', pos: '動詞', sub1: '自立', start: 0, end: 2 },
      { surface: 'た', baseForm: 'た', pos: '助動詞', sub1: '*', start: 2, end: 3 },
    ])
    expect(joinJapaneseMorphemes(morphemes)).toEqual([{ start: 0, end: 3, lemma: '食べる' }])
  })
})

describe('byteToCharRanges — 바이트와 문자 오프셋', () => {
  it('아스키는 그대로다', () => {
    expect(
      byteToCharRanges('abc', [
        { byteStart: 0, byteEnd: 1 },
        { byteStart: 1, byteEnd: 3 },
      ]),
    ).toEqual([
      [0, 1],
      [1, 3],
    ])
  })

  /** ぱ(U+3071)는 UTF-8 3바이트, 이모지는 UTF-16 서로게이트 — 둘 다 어긋난다 */
  it('멀티바이트 뒤의 단어가 어긋나지 않는다', () => {
    const text = 'ぱンを🍞食べた'
    const encoder = new TextEncoder()
    const bytes = encoder.encode(text)
    // ぱ(0-3) ん(3-6) を(6-9) 🍞(9-13) 食(13-16) べ(16-19) た(19-22)
    expect(bytes.length).toBe(22)
    expect(
      byteToCharRanges(text, [
        { byteStart: 13, byteEnd: 16 },
        { byteStart: 19, byteEnd: 22 },
      ]),
    ).toEqual([
      [4, 5],
      [6, 7],
    ])
  })
})
