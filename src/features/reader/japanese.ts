import { useEffect, useMemo, useState } from 'react'

import type { LanguageCode, Segment, Sentence } from '../../types'
import { computeSentences } from './tokenizer'

/**
 * 일본어 형태소 분석 (lindera + IPADIC).
 *
 * Intl.Segmenter 는 활용어를 어간과 어미로 찢는다 (食べた → 食|べた).
 * べた 는 어휘가 아니라 상태도 사전도 의미가 없고, 食べる 라는 단어는 어디에도
 * 나타나지 않는다. 학습용으로는 치명적이라 형태소 분석기로 원형·품사를 본다.
 *
 * 원칙:
 * - 엔진(~2MB)은 일본어 문서를 열 때 동적 import 로만 받아 온다.
 * - 사전(~10MB)은 번들에 넣지 않는다. 첫 사용 시 내려받아 OPFS 에 캐시하고,
 *   그 뒤엔 오프라인에서도 동작한다. 없으면 Intl.Segmenter 로 폴백한다.
 * - 먼저 Intl 로 그리고 준비되면 갈아끼운다 — 10MB 를 기다리게 하지 않는다.
 */

const DICT_NAME = 'ipadic-5.3.0'
const DICT_URL = '/dicts/lindera-ipadic-5.3.0.zip'

/** lindera 토큰 — 필요한 것만 뽑는다 */
export type LinderaToken = {
  surface: string
  /**
   * IPADIC 상세 [品詞, 細分類1, 細分類2, 細分類3, 活用形, 活用型, 原形, 読み, 発音].
   *
   * 웹 빌드는 이 배열로 주고, 이름 붙은 getter(baseForm 등)는 node 빌드에만
   * 있다 — 직접 필드를 읽으면 브라우저에서 undefined 가 나온다. 실제로 그렇게
   * 되어 食べた 이 합쳐지지 않았다. 배열을 먼저 보고 없으면 이름으로 본다.
   */
  details?: string[]
  baseForm?: string | null
  partOfSpeech?: string | null
  partOfSpeechSubcategory1?: string | null
  byteStart?: number
  byteEnd?: number
  byte_start?: number
  byte_end?: number
}

export type JaTokenizer = {
  tokenize: (text: string) => LinderaToken[]
}

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

let cached: JaTokenizer | null = null
let loading: Promise<JaTokenizer | null> | null = null
let ready = false
const listeners = new Set<() => void>()

export function isJapaneseReady(): boolean {
  return ready
}

function subscribeJapaneseReady(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function markReady(tokenizer: JaTokenizer | null): JaTokenizer | null {
  cached = tokenizer
  if (tokenizer) {
    ready = true
    for (const listener of listeners) listener()
  } else {
    // 실패는 세션에 남기지 않는다 — 오프라인이었다가 온라인이 되면 다음에 다시 시도한다
    loading = null
  }
  return tokenizer
}

/**
 * 일본어 토크나이저를 준비한다 — 성공하면 같은 것을 돌려준다.
 *
 * 실패하면 null 이다. 사전이 없고 네트워크도 없으면 Intl.Segmenter 로 폴백한다 —
 * 일본어 문서가 안 열리는 일은 없다.
 */
export function ensureJapaneseTokenizer(): Promise<JaTokenizer | null> {
  if (cached) return Promise.resolve(cached)
  if (!loading) {
    loading = loadJapaneseTokenizer()
      .then(markReady)
      .catch(() => markReady(null))
  }
  return loading
}

async function loadJapaneseTokenizer(): Promise<JaTokenizer | null> {
  if (typeof window === 'undefined') return null
  try {
    const [{ TokenizerBuilder, loadDictionaryFromBytes }, opfs] = await Promise.all([
      import('lindera-wasm-bundler'),
      import('lindera-wasm-bundler/opfs'),
    ])
    if (!(await opfs.hasDictionary(DICT_NAME))) {
      await opfs.downloadDictionary(DICT_URL, DICT_NAME)
    }
    const files = await opfs.loadDictionaryFiles(DICT_NAME)
    const dictionary = loadDictionaryFromBytes(
      files.metadata,
      files.dictTrie,
      files.dictValsIdx,
      files.dictVals,
      files.dictWordsIdx,
      files.dictWords,
      files.matrixMtx,
      files.charDef,
      files.unk,
    )
    const builder = new TokenizerBuilder()
    builder.setDictionaryInstance(dictionary)
    builder.setMode('normal')
    const tokenizer = builder.build()
    return { tokenize: (text: string) => tokenizer.tokenize(text) as LinderaToken[] }
  } catch {
    return null
  }
}

/**
 * lindera 바이트 오프셋을 문자 오프셋으로 바꾼다.
 *
 * lindera 는 UTF-8 바이트를 주고, JS 문자열은 UTF-16 이라 서로 다르다 —
 * 그대로 쓰면 이모지·옛 한자 뒤의 단어가 어긋난다.
 */
export function byteToCharRanges(
  text: string,
  spans: Array<{ byteStart: number; byteEnd: number }>,
): Array<[number, number]> {
  const byteToChar = new Map<number, number>()
  let byte = 0
  let char = 0
  for (const ch of text) {
    byteToChar.set(byte, char)
    byte += new TextEncoder().encode(ch).length
    char += 1
  }
  byteToChar.set(byte, char)

  return spans.map((span) => [
    byteToChar.get(span.byteStart) ?? 0,
    byteToChar.get(span.byteEnd) ?? text.length,
  ])
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
  if (!cached) return null
  const sentences = computeSentences(text)
  const morphemes = toMorphemes(text, cached.tokenize(text))
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
  const active = languageCode === 'ja'
  const [upgraded, setUpgraded] = useState(() => isJapaneseReady())

  useEffect(() => {
    if (!active) return
    if (isJapaneseReady()) {
      setUpgraded(true)
      return
    }
    let cancelled = false
    // 준비되면 다시 그린다 — effect 안에서 구독을 먼저 걸어 놓친다
    const unsubscribe = subscribeJapaneseReady(() => {
      if (!cancelled) setUpgraded(true)
    })
    void ensureJapaneseTokenizer()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [active])

  return useMemo(() => {
    if (!active || !upgraded) return null
    return segmentJapanese(text)
  }, [active, text, upgraded])
}
