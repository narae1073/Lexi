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

import { createTranslator, type AppLanguage } from '../../i18n'

export type LinderaDict = 'ja' | 'zh'

/**
 * 사전 zip 의 정확한 크기.
 *
 * 다운로드 전에 사용자에게 이 숫자를 보여 준다 — 10.5 MB 는 요금제에 따라
 * 공짜가 아니고, 앱이 말없이 받아서는 안 되는 크기다. 사전 자체는 번들에
 * 넣지 않는다 (번들이 10 MB 넘게 커진다).
 */
export const DICTIONARY_DOWNLOADS: Record<
  LinderaDict,
  { name: string; url: string; bytes: number; label: string }
> = {
  ja: {
    name: 'ipadic-5.3.0',
    url: '/dicts/lindera-ipadic-5.3.0.zip',
    bytes: Math.round(10.5 * 1024 * 1024),
    label: '10.5 MB',
  },
  zh: {
    name: 'cc-cedict-5.3.0',
    url: '/dicts/lindera-cc-cedict-5.3.0.zip',
    bytes: Math.round(7.25 * 1024 * 1024),
    label: '7.25 MB',
  },
}

/**
 * 사전을 말없이 받아도 되는 환경인가.
 *
 * 사용자가 자동 다운로드를 켰더라도 `saveData`(데이터 절약)나 2G 급 연결,
 * 셀룰러로 보고된 연결에서는 묻는다. 연결 정보를 브라우저가 안 알려 주면
 * (`effectiveType`/`connectionType` 없음) 자동을 막지 않는다 — 알 수 없는 것을
 * 느린 연결로 단정하면 매번 묻게 된다.
 */
export type DictionaryDownloadEnvironment = {
  /** 사용자 설정: 묻지 않고 받기 */
  autoDownload: boolean
  saveData: boolean
  /** NetworkInformation.effectiveType — 'slow-2g' | '2g' | '3g' | '4g' */
  effectiveType?: string
  /** NetworkInformation.type — 대부분의 브라우저는 노출하지 않는다 */
  connectionType?: string
  online: boolean
}

const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g'])

export function shouldAutoDownload(env: DictionaryDownloadEnvironment): boolean {
  if (!env.autoDownload || !env.online || env.saveData) return false
  if (env.effectiveType && SLOW_EFFECTIVE_TYPES.has(env.effectiveType)) return false
  if (env.connectionType === 'cellular') return false
  return true
}

/** 설정 화면의 '묻지 않고 받기' 값. 기기별 취향이라 localStorage 에 둔다. */
const AUTO_DOWNLOAD_KEY = 'lexi.dictionary.autoDownload'

export function isDictionaryAutoDownloadEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(AUTO_DOWNLOAD_KEY) === 'true'
  } catch {
    return false
  }
}

export function setDictionaryAutoDownloadEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AUTO_DOWNLOAD_KEY, enabled ? 'true' : 'false')
  } catch {
    // 저장 못 해도 이번 세션의 동작은 유지된다
  }
}

type NetworkInformationLike = {
  saveData?: boolean
  effectiveType?: string
  type?: string
}

function currentDownloadEnvironment(): DictionaryDownloadEnvironment {
  if (typeof navigator === 'undefined') {
    return { autoDownload: false, saveData: false, online: false }
  }
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike })
    .connection
  return {
    autoDownload: isDictionaryAutoDownloadEnabled(),
    saveData: connection?.saveData === true,
    effectiveType: connection?.effectiveType,
    connectionType: connection?.type,
    online: navigator.onLine !== false,
  }
}

/**
 * 확인 대화상자 문구. 사전 이름과 정확한 크기를 넣고 앱 언어로 쓴다.
 *
 * React 훅이 아니라 확인 창/설정 화면에서 바로 쓸 수 있게 순수 함수로 둔다.
 */
export function dictionaryPromptMessage(
  dict: LinderaDict,
  language: AppLanguage = 'en',
): string {
  const t = createTranslator(language)
  const name = t(dict === 'ja' ? 'languageNames.ja' : 'languageNames.zh')
  return t('dictionary.downloadPrompt', { language: name, size: DICTIONARY_DOWNLOADS[dict].label })
}

function appLanguage(): AppLanguage {
  if (typeof document === 'undefined') return 'en'
  return document.documentElement.lang === 'ko' ? 'ko' : 'en'
}

/**
 * 기본 확인 방법. 브라우저 확인 창을 쓴다.
 *
 * 확인 창이 없는 환경(테스트·아주 오래된 브라우저)에서는 거절로 본다 —
 * 허락 없이 10 MB 를 받는 것보다 폴백이 낫다.
 */
function confirmDownload(dict: LinderaDict): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return Promise.resolve(false)
  }
  return Promise.resolve(window.confirm(dictionaryPromptMessage(dict, appLanguage())))
}

/**
 * 이번 세션에 사용자가 거절한 사전.
 *
 * 거절은 존중한다 — 문서를 열 때마다 같은 확인 창을 다시 띄우면 괴롭다.
 * 설정 화면에서 명시적으로 다시 받겠다고 하면 지운다.
 */
const declinedThisSession = new Set<LinderaDict>()

async function promptOnce(dict: LinderaDict): Promise<boolean> {
  if (declinedThisSession.has(dict)) return false
  const allowed = await confirmDownload(dict)
  if (allowed) declinedThisSession.delete(dict)
  else declinedThisSession.add(dict)
  return allowed
}

/** 사전을 실제로 읽고 토크나이저를 만드는 부분 — 테스트에서 갈아끼울 수 있다. */
export type LinderaLoadDeps = {
  hasDictionary: (name: string) => Promise<boolean>
  downloadDictionary: (url: string, name: string) => Promise<void>
  loadTokenizer: (name: string) => Promise<LinderaTokenizer>
}

/**
 * 사전 확보 + 로딩의 핵심 경로.
 *
 * 이미 OPFS 에 있으면 그냥 연다. 없으면 자동 다운로드가 허락된 경우에만
 * 묻지 않고 받고, 아니면 확인을 받는다. 거절하면 null — 호출부는 기존
 * Intl 분절로 폴백한다.
 */
export async function loadLinderaWith(
  dict: LinderaDict,
  deps: LinderaLoadDeps,
  env: DictionaryDownloadEnvironment,
  confirm: (dict: LinderaDict) => Promise<boolean>,
): Promise<LinderaTokenizer | null> {
  const { name, url } = DICTIONARY_DOWNLOADS[dict]

  if (!(await deps.hasDictionary(name))) {
    const allowed = shouldAutoDownload(env) || (await confirm(dict))
    if (!allowed) return null
    await deps.downloadDictionary(url, name)
  }

  return deps.loadTokenizer(name)
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
 * 실패하면 null 이다. 사전이 없고 네트워크도 없거나 사용자가 다운로드를
 * 거절하면 기존 분절기로 폴백한다 — 문서가 안 열리는 일은 없다.
 *
 * `forcePrompt` 는 설정 화면의 명시적 다운로드용이다. 자동 다운로드가 켜져
 * 있어도 정확한 크기를 보여 주고 확인을 받는다.
 */
export function ensureLindera(
  dict: LinderaDict,
  options: { forcePrompt?: boolean } = {},
): Promise<LinderaTokenizer | null> {
  const hit = cached.get(dict)
  if (hit) return Promise.resolve(hit)
  const ongoing = loading.get(dict)
  if (ongoing) return ongoing
  const next = loadLindera(dict, options)
    .then((tokenizer) => markReady(dict, tokenizer))
    .catch(() => markReady(dict, null))
  loading.set(dict, next)
  return next
}

async function loadLindera(
  dict: LinderaDict,
  options: { forcePrompt?: boolean } = {},
): Promise<LinderaTokenizer | null> {
  if (typeof window === 'undefined') return null
  try {
    const [{ TokenizerBuilder, loadDictionaryFromBytes }, opfs] = await Promise.all([
      import('lindera-wasm-bundler'),
      import('lindera-wasm-bundler/opfs'),
    ])

    const deps: LinderaLoadDeps = {
      hasDictionary: (name) => opfs.hasDictionary(name),
      downloadDictionary: (url, name) => opfs.downloadDictionary(url, name),
      loadTokenizer: async (name) => {
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
      },
    }

    const env = currentDownloadEnvironment()
    // 명시적 다운로드는 자동 설정과 무관하게 항상 크기를 보여 주고 묻는다
    const confirm = options.forcePrompt
      ? confirmDownload
      : promptOnce
    return await loadLinderaWith(dict, deps, env, confirm)
  } catch {
    return null
  }
}

/**
 * 설정 화면에서 사전을 명시적으로 받는다.
 *
 * 세션 거절 기록을 지우고 다시 확인을 받는다 — 사용자가 직접 누른 것이므로
 * 이전 거절을 이유로 막지 않는다.
 */
export async function requestDictionaryDownload(dict: LinderaDict): Promise<boolean> {
  declinedThisSession.delete(dict)
  const tokenizer = await ensureLindera(dict, { forcePrompt: true })
  return tokenizer !== null
}

/** OPFS 에 이미 있는 사전 목록. 설정 화면 표시용이며, 실패하면 빈 배열이다. */
export async function downloadedDictionaries(): Promise<LinderaDict[]> {
  if (typeof window === 'undefined') return []
  try {
    const opfs = await import('lindera-wasm-bundler/opfs')
    const found: LinderaDict[] = []
    for (const dict of ['ja', 'zh'] as const) {
      if (await opfs.hasDictionary(DICTIONARY_DOWNLOADS[dict].name)) found.push(dict)
    }
    return found
  } catch {
    return []
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
