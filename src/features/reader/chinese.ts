import type { LanguageCode, Segment, Sentence } from '../../types'
import {
  byteToCharRanges,
  ensureLindera,
  isLinderaReady,
  peekLindera,
  useLinderaUpgrade,
} from './lindera'
import { computeSentences } from './tokenizer'

/**
 * 중국어 형태소 분석 (lindera + CC-CEDICT).
 *
 * Intl.Segmenter 도 중국어는 곧잘 나누지만(喜欢|学习|中文), 고유명사와
 * 합성어는 찢는다 (北京|大学). CC-CEDICT 는 사전 항목 단위라 학습 단위와
 * 같다 — 北京大学, 自然语言处理 가 한 단어다. 사전 조회도 그 항목으로 간다.
 *
 * 일본어와 달리 합치기가 필요 없다 — 중국어에 활용이 없으므로 형태소 하나가
 * 단어 하나고, lemma 는 표기 그대로다. 기호·숫자만으로는 단어가 되지 않는다 —
 * 본문 토크나이저와 같은 규칙이다.
 */

export type ZhSegmentation = {
  segments: Segment[]
  sentences: Sentence[]
  /** 시작 오프셋 → 원형(=표기). 표기가 겹쳐도 자리가 다르면 다르다 */
  lemmaByStart: Map<number, string>
}

/** 하위 호환 — 호출부는 이 이름으로 준비를 확인한다 */
export function isChineseReady(): boolean {
  return isLinderaReady('zh')
}

export function ensureChineseTokenizer() {
  return ensureLindera('zh')
}

/**
 * 중국어 본문을 lindera 로 분절한다 — 준비되지 않았으면 null.
 *
 * tokenize() 와 같은 모양(빈틈없는 세그먼트 + 문장 + 원형표)을 돌려주므로
 * 호출부는 갈아끼우기만 하면 된다.
 */
export function segmentChinese(text: string): ZhSegmentation | null {
  const tokenizer = peekLindera('zh')
  if (!tokenizer) return null
  const sentences = computeSentences(text)
  const tokens = tokenizer.tokenize(text)

  const ranges = byteToCharRanges(
    text,
    tokens.map((token) => ({
      byteStart: token.byteStart ?? token.byte_start ?? 0,
      byteEnd: token.byteEnd ?? token.byte_end ?? 0,
    })),
  )

  const sentenceIndexAt = (offset: number): number => {
    const s = sentences.find((c) => offset >= c.start && offset < c.end)
    return s ? s.index : sentences.length - 1
  }

  const segments: Segment[] = []
  const lemmaByStart = new Map<number, string>()
  let cursor = 0
  ranges.forEach(([start, end]) => {
    const surface = text.slice(start, end)
    // 글자가 없으면 단어가 아니다 — 기호·숫자는 본문 그대로 둔다
    if (!/\p{L}/u.test(surface)) {
      return
    }
    if (start > cursor) {
      segments.push({
        type: 'text',
        start: cursor,
        end: start,
        text: text.slice(cursor, start),
      })
    }
    segments.push({
      type: 'word',
      start,
      end,
      text: surface,
      lemma: surface,
      sentenceIndex: sentenceIndexAt(start),
    })
    lemmaByStart.set(start, surface)
    cursor = end
  })
  if (cursor < text.length) {
    segments.push({ type: 'text', start: cursor, end: text.length, text: text.slice(cursor) })
  }

  return { segments, sentences, lemmaByStart }
}

/**
 * 중국어 업그레이드 훅 — 준비되면 lindera 분절을 돌려준다.
 *
 * 처음엔 null 이라 호출부는 Intl 경로로 그리고, 준비되는 순간 다시 그린다.
 * effect 가 준비를 트리거하므로, 이 훅을 쓰는 화면은 자동으로 업그레이드된다.
 */
export function useChineseUpgrade(text: string, languageCode: LanguageCode): ZhSegmentation | null {
  return useLinderaUpgrade(text, languageCode === 'zh', 'zh', segmentChinese)
}
