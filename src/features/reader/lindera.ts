/**
 * lindera 공용 하네스 — 엔진 지연 로딩 + 사전 OPFS 캐시 + 폴백.
 *
 * 원칙 (일본어 통합 때 세운 것 그대로):
 * - 엔진(~2MB)은 해당 언어 문서를 열 때 동적 import 로만 받아 온다.
 * - 사전은 번들에 넣지 않는다. 첫 사용 시 내려받아 OPFS 에 캐시하고,
 *   그 뒤엔 오프라인에서도 동작한다. 없으면 null — 호출부는 기존 분절기로 폴백한다.
 * - 먼저 기존 분절기로 그리고 준비되면 갈아끼운다 — 사전을 기다리게 하지 않는다.
 *
 * 언어별 규칙(합치기·원형)은 각 언어 모듈(japanese.ts, chinese.ts)이 맡고,
 * 여기는 '받아 오고 캐시하고 준비를 알리는' 일만 한다.
 */
import { useEffect, useMemo, useState } from 'react'

export type LinderaDict = 'ja' | 'zh'

const DICTS: Record<
  LinderaDict,
  { name: string; url: string }
> = {
  ja: { name: 'ipadic-5.3.0', url: '/dicts/lindera-ipadic-5.3.0.zip' },
  zh: { name: 'cc-cedict-5.3.0', url: '/dicts/lindera-cc-cedict-5.3.0.zip' },
}

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

export type LinderaTokenizer = {
  tokenize: (text: string) => LinderaToken[]
}

const cached = new Map<LinderaDict, LinderaTokenizer>()
const loading = new Map<LinderaDict, Promise<LinderaTokenizer | null>>()
const listeners = new Map<LinderaDict, Set<() => void>>()

export function isLinderaReady(dict: LinderaDict): boolean {
  return cached.has(dict)
}

/** 준비된 것을 꺼낸다 — 없으면 null. effect·메모 안에서 동기 확인용이다 */
export function peekLindera(dict: LinderaDict): LinderaTokenizer | null {
  return cached.get(dict) ?? null
}

export function subscribeLinderaReady(dict: LinderaDict, listener: () => void): () => void {
  let set = listeners.get(dict)
  if (!set) {
    set = new Set()
    listeners.set(dict, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

function markReady(dict: LinderaDict, tokenizer: LinderaTokenizer | null): LinderaTokenizer | null {
  if (tokenizer) {
    cached.set(dict, tokenizer)
    for (const listener of listeners.get(dict) ?? []) listener()
  }
  // 실패는 남기지 않는다 — 오프라인이었다가 온라인이 되면 다음에 다시 시도한다
  loading.delete(dict)
  return tokenizer
}

/**
 * 토크나이저를 준비한다 — 성공하면 같은 것을 돌려준다.
 *
 * 실패하면 null 이다. 사전이 없고 네트워크도 없으면 기존 분절기로 폴백한다 —
 * 문서가 안 열리는 일은 없다.
 */
export function ensureLindera(dict: LinderaDict): Promise<LinderaTokenizer | null> {
  const hit = cached.get(dict)
  if (hit) return Promise.resolve(hit)
  const ongoing = loading.get(dict)
  if (ongoing) return ongoing
  const next = loadLindera(dict)
    .then((tokenizer) => markReady(dict, tokenizer))
    .catch(() => markReady(dict, null))
  loading.set(dict, next)
  return next
}

async function loadLindera(dict: LinderaDict): Promise<LinderaTokenizer | null> {
  if (typeof window === 'undefined') return null
  try {
    const [{ TokenizerBuilder, loadDictionaryFromBytes }, opfs] = await Promise.all([
      import('lindera-wasm-bundler'),
      import('lindera-wasm-bundler/opfs'),
    ])
    const { name, url } = DICTS[dict]
    if (!(await opfs.hasDictionary(name))) {
      await opfs.downloadDictionary(url, name)
    }
    const files = await opfs.loadDictionaryFiles(name)
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

/**
 * 업그레이드 훅 — 준비되면 해당 언어 분절을 돌려준다.
 *
 * 처음엔 null 이라 호출부는 기존 경로로 그리고, 준비되는 순간 다시 그린다.
 * effect 가 준비를 트리거하므로, 이 훅을 쓰는 화면은 자동으로 업그레이드된다.
 */
export function useLinderaUpgrade<T>(
  text: string,
  active: boolean,
  dict: LinderaDict,
  segment: (text: string) => T | null,
): T | null {
  const [upgraded, setUpgraded] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    // 준비되면 다시 그린다 — effect 안에서 구독을 먼저 걸어 놓친다
    const unsubscribe = subscribeLinderaReady(dict, () => {
      if (!cancelled) setUpgraded(true)
    })
    void ensureLindera(dict)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [active, dict])

  // effect 안에서 setState 를 바로 부르면 렌더가 연쇄된다 — 준비 여부는 그려서 본다
  const show = active && (upgraded || isLinderaReady(dict))
  return useMemo(() => {
    if (!show) return null
    return segment(text)
  }, [show, text, segment])
}
