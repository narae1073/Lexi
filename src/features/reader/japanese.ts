import type { LanguageCode, Segment, Sentence } from '../../types'
import {
  byteToCharRanges,
  ensureLindera,
  isLinderaReady,
  peekLindera,
  useLinderaUpgrade,
  type LinderaToken,
} from './lindera'
import { computeSentences } from './tokenizer'

/**
 * 일본어 형태소 분석 (lindera + IPADIC).
 *
 * Intl.Segmenter 는 활용어를 어간과 어미로 찢는다 (食べた → 食|べた).
 * べた 는 어휘가 아니라 상태도 사전도 의미가 없고, 食べる 라는 단어는 어디에도
 * 나타나지 않는다. 학습용으로는 치명적이라 형태소 분석기로 원형·품사를 본다.
 *
 * 받아 오기·캐시·준비는 공용 하네스(lindera.ts)가 맡고, 여기는 일본어 규칙
 * (합치기·원형)만 둔다.
 */

export type JaMorpheme = {
  surface: string
  baseForm: string
  pos: string
  sub1: string
  start: number
  end: number
}

export type JaSegmentation = {
  segments: Segment[]
  sentences: Sentence[]
  /** 시작 오프셋 → 원형. 표기가 겹쳐도 자리가 다르면 다르다 */
  lemmaByStart: Map<number, string>
}

/** 하위 호환 — 호출부는 이 이름으로 준비를 확인한다 */
export function isJapaneseReady(): boolean {
  return isLinderaReady('ja')
}

export function ensureJapaneseTokenizer() {
  return ensureLindera('ja')
}

/** lindera 토큰 → 문자 오프셋 형태소. 원형이 없으면(*) 표기를 쓴다 */
export function toMorphemes(text: string, tokens: LinderaToken[]): JaMorpheme[] {
  const spans = tokens.map((token) => ({
    byteStart: token.byteStart ?? token.byte_start ?? 0,
    byteEnd: token.byteEnd ?? token.byte_end ?? 0,
  }))
  const ranges = byteToCharRanges(text, spans)
  return tokens.map((token, i) => {
    const details = Array.isArray(token.details) ? token.details : []
    const base = details[6] ?? token.baseForm ?? null
    return {
      surface: token.surface,
      baseForm: base && base !== '*' ? base : token.surface,
      pos: details[0] ?? token.partOfSpeech ?? '',
      sub1: details[1] ?? token.partOfSpeechSubcategory1 ?? '',
      start: ranges[i]?.[0] ?? 0,
      end: ranges[i]?.[1] ?? 0,
    }
  })
}

/**
 * 형태소를 학습 단위로 합친다.
 *
 * IPADIC 은 형태소 단위라 활용이 찢어진다 (食べ|た). 어미(助動詞)와
 * 접미사(接尾), 접속조사(接続助詞 て·で)는 앞 단어에 붙이고, 접두사(接頭辞)는
 * 뒷 단어와 합친다. 합친 단어의 lemma 는 맨 앞 형태소의 원형이다 —
 * 食べ+た → 食べた/食べる, 読ん+で → 読んで/読む.
 *
 * 조사는 단어로 남긴다. 단, 接続助詞(食べて 의 て)와 格助詞(空港で 의 で)는
 * 다르다 — 앞은 활용의 일부라 붙고, 뒤는 자리 표시라 따로 선다.
 * 기호(記号)와 숫자만으로는 단어가 되지 않는다 — 본문 토크나이저와 같은 규칙이다.
 */
export function joinJapaneseMorphemes(morphemes: JaMorpheme[]): Array<{
  start: number
  end: number
  lemma: string
}> {
  const words: Array<{ start: number; end: number; lemma: string; prefixHead: boolean }> = []
  /** 접두사가 다음 형태소를 기다리는 중인가 */
  let prefixOpen = false

  for (const m of morphemes) {
    if (m.pos === '記号' || !/\p{L}/u.test(m.surface)) {
      // 구두점·숫자는 단어가 아니다 — 접두사의 기다림도 여기서 끊는다.
      // 끊지 않으면 お、茶 이 お茶 으로 붙는다.
      prefixOpen = false
      continue
    }

    // 실측(IPADIC): 接頭詞 sub1=名詞接続/数接続, 接尾 sub1=接尾, 助動詞 sub1=*.
    const attachesPrev =
      m.pos === '助動詞' || m.sub1 === '接尾' || (m.pos === '助詞' && m.sub1 === '接続助詞')
    const last = words.at(-1)

    if ((attachesPrev || prefixOpen) && last) {
      last.end = m.end
      // 接頭辞로 시작한 단어는 실질 형태소의 원형을 쓴다 — お茶さん→お 가 아니라 茶.
      // 사전에서 お 를 찾으면 접두사 설명만 나오고, 茶 를 찾아야 차가 나온다.
      // 어미·조사가 딸려 와도 실질어는 그대로 둔다.
      const isContent = !['助動詞', '助詞', '記号', '接頭詞'].includes(m.pos)
      if (prefixOpen && last.prefixHead && isContent) {
        last.lemma = m.baseForm
        last.prefixHead = false
      }
    } else {
      words.push({ start: m.start, end: m.end, lemma: m.baseForm, prefixHead: m.pos === '接頭詞' })
    }
    prefixOpen = m.pos === '接頭詞'
  }

  return words.map(({ start, end, lemma }) => ({ start, end, lemma }))
}

/**
 * 일본어 본문을 lindera 로 분절한다 — 준비되지 않았으면 null.
 *
 * tokenize() 와 같은 모양(빈틈없는 세그먼트 + 문장 + 원형표)을 돌려주므로
 * 호출부는 갈아끼우기만 하면 된다.
 */
export function segmentJapanese(text: string): JaSegmentation | null {
  const tokenizer = peekLindera('ja')
  if (!tokenizer) return null
  const sentences = computeSentences(text)
  const morphemes = toMorphemes(text, tokenizer.tokenize(text))
  const words = joinJapaneseMorphemes(morphemes)

  const sentenceIndexAt = (offset: number): number => {
    const s = sentences.find((c) => offset >= c.start && offset < c.end)
    return s ? s.index : sentences.length - 1
  }

  const segments: Segment[] = []
  const lemmaByStart = new Map<number, string>()
  let cursor = 0
  for (const word of words) {
    if (word.start > cursor) {
      segments.push({
        type: 'text',
        start: cursor,
        end: word.start,
        text: text.slice(cursor, word.start),
      })
    }
    const surface = text.slice(word.start, word.end)
    segments.push({
      type: 'word',
      start: word.start,
      end: word.end,
      text: surface,
      lemma: word.lemma,
      sentenceIndex: sentenceIndexAt(word.start),
    })
    lemmaByStart.set(word.start, word.lemma)
    cursor = word.end
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', start: cursor, end: text.length, text: text.slice(cursor) })
  }

  return { segments, sentences, lemmaByStart }
}

/**
 * 일본어 업그레이드 훅 — 준비되면 lindera 분절을 돌려준다.
 *
 * 처음엔 null 이라 호출부는 Intl 경로로 그리고, 준비되는 순간 다시 그린다.
 * effect 가 준비를 트리거하므로, 이 훅을 쓰는 화면은 자동으로 업그레이드된다.
 */
export function useJapaneseUpgrade(text: string, languageCode: LanguageCode): JaSegmentation | null {
  return useLinderaUpgrade(text, languageCode === 'ja', 'ja', segmentJapanese)
}
