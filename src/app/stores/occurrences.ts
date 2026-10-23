import { create } from 'zustand'

import {
  STORES,
  idbDelete,
  idbDeleteByIndex,
  idbGet,
  idbGetAll,
  idbGetAllByIndex,
  idbPut,
  isReservedDocumentMetaId,
  replaceOccurrences,
} from '../../lib/storage/localDb'
import { sameOccurrenceRecords } from '../../lib/sync/occurrenceNoop'
import { isCapitalisedPosition, tokenize } from '../../features/reader/tokenizer'
import {
  ensureJapaneseTokenizer,
  isJapaneseReady,
  segmentJapanese,
} from '../../features/reader/japanese'
import {
  ensureChineseTokenizer,
  isChineseReady,
  segmentChinese,
} from '../../features/reader/chinese'
import { LEMMA_VERSION, resolveLemmasFromWords } from '../../features/reader/surfaceLemma'
import type { Document, LanguageCode, Segment, Sentence } from '../../types'

/**
 * 단어가 문서에서 실제로 등장한 기록.
 *
 * 왜 이것이 필요한가: 단어 상태(○◐●)는 사용자가 직접 바꾼 단어에만 생긴다.
 * 문서에는 있지만 아직 건드리지 않은 단어는 어디에도 남지 않아,
 * 단어장이 "클릭한 단어만 모은 목록" 이 되어 버린다. 등장 기록이 그 원본 데이터다.
 *
 * schema(word_occurrences) 와 같은 형태이며, Phase 6 에서 서버로 옮길 때 그대로 쓴다.
 */
export type WordOccurrence = {
  documentId: string
  languageCode: LanguageCode
  /** 표기 → lemma 매핑으로 정규화한 대표 형태 (US 와 us 는 분리된다) */
  lemma: string
  /** 이 lemma 이 이 문서에서 쓰인 표기들 */
  surfaces: string[]
  /** 등장 횟수 */
  count: number
  /** 언제 기록됐는지 — 예문으로 가장 최근 문서를 고를 때 쓴다 */
  recordedAt: number
  /** 단어장의 문맥 예문 */
  charStart: number
  charEnd: number
  sentence: string
  documentTitle: string
}

type OccurrencesState = {
  /** languageCode 별 등장 기록 */
  byLanguage: Record<string, WordOccurrence[]>
  /**
   * 적재된 모든 등장 기록 (언어 구분 없이).
   *
   * 문서 목록에서 문서별로 묶어 진도를 내려면 전체가 필요하다. 언어별로 쪼개진
   * 맵을 다시 합치는 대신 여기 한 벌�� 둔다 — 목록은 한 번만 계산한다.
   */
  occurrences: WordOccurrence[]
  /** 이미 기록을 끝낸 문서 id — 다시 열 때 중복 기록하지 않기 위함 */
  recorded: Record<string, true>
  /** 진도 계산이 도는 중인지 — 동시 호출을 막는다 */
  refreshing: boolean
  recordDocument: (doc: Document, force?: boolean) => Promise<void>
  loadLanguage: (languageCode: LanguageCode) => Promise<void>
  forgetDocument: (documentId: string) => Promise<void>
  /**
   * 옛 표기 규칙으로 계산된 기록을 문�� 다시 계산한다.
   *
   * 서버에 있는 기록은 규칙이 바뀐 뒤에도 옛 결과로 남아 있다. 그 문서를
   * 직접 열기 전까지는 기기마다 단어장이 다르다 — 문서 안의 단어를 전부
   * 열린 상태로 돌려놓는 것이 사용자 몫이 되어서는 안 된다.
   */
  refreshStaleDocuments: (docs: Document[]) => Promise<number>
}

/** 서버의 word_occurrences 제약과 같은 상한 — 넘는 행은 동기화가 거부한다 */
const MAX_WORD_LENGTH = 200
const MAX_SENTENCE_LENGTH = 5_000

/** One `documentMeta` row — which rules this device used for the document. */
type DocumentMetaRow = {
  documentId: string
  lemmaVersion: number
  segmenter?: string
  /** When the occurrence rows were last written — sync uses it to pick this document */
  occurrencesUpdatedAt?: string
}

/**
 * Remembers a computation whose output did not change.
 *
 * It refreshes `lemmaVersion`/`segmenter` but **never touches
 * `occurrencesUpdatedAt`**. That timestamp means "this device changed the
 * occurrence rows"; stamping it on a computation that wrote nothing would make
 * sync send the same content again. An existing timestamp is kept as is.
 *
 * The rule version must still be recorded: if identical output meant skipping
 * this bookkeeping, a document computed under an old rule would stay "stale"
 * forever and be recomputed on every app start.
 */
async function rememberUnchangedComputation(
  documentId: string,
  segmenter: 'lindera' | 'intl',
): Promise<void> {
  const meta = await idbGet<DocumentMetaRow>(STORES.documentMeta, documentId).catch(() => undefined)
  if (meta?.lemmaVersion === LEMMA_VERSION && meta.segmenter === segmenter) return
  await idbPut(STORES.documentMeta, {
    ...meta,
    documentId,
    lemmaVersion: LEMMA_VERSION,
    segmenter,
  }).catch(() => {})
}

/** 단어장 정렬용: 문서 내 등장 순서를 유지한다 */
function sortByPosition(a: WordOccurrence, b: WordOccurrence) {
  return a.charStart - b.charStart
}

/** languageCode 별 맵에서 전체 목록을 다시 잇는다 — 적재가 끝날 때마다 한 번만 */
function flatten(byLanguage: Record<string, WordOccurrence[]>): WordOccurrence[] {
  return Object.values(byLanguage).flat()
}

/**
 * 한 문서의 기록을 그 언어의 목록에 합친다 — 이 문서 것만 남겨서는 안 된다.
 *
 * 언어를 열 때마다 갈아끼우면, 방금 연 문서의 단어만 보인다. 같은 언어로 된 다른
 * 문서들이 말짱 사라지는 셈이고, 사용자는 '단어장이 그 문서만 기억하나' 로 오해한다.
 * German 문서를 하나 열었다 닫았다 하며 German 단어장에 그 문서 단어만 뜨는 것이
 * 이 버그였다.
 *
 * 이 문서의 것만 갈아끼운다 — 같은 (문서, lemma) 가 기록끼리 겹치는 유일한 경우다.
 * charStart 는 문서 안의 위치라 문서끼리 비교할 수 없다.
 */
export function mergeByLanguage(
  byLanguage: Record<string, WordOccurrence[]>,
  languageCode: string,
  documentId: string,
  records: WordOccurrence[],
): Record<string, WordOccurrence[]> {
  const others = (byLanguage[languageCode] ?? []).filter((r) => r.documentId !== documentId)
  return { ...byLanguage, [languageCode]: [...others, ...records].sort(sortByPosition) }
}

/**
 * 두 기록 목록이 같은 내용인지.
 *
 * 동기화는 자주 돌고, 이 목록은 목록 화면의 진도 계산 전체를 먹인다. 내용이 같으면
 * 그대로 둔다 — 사용자에게 보일 변화가 없는 것을 바꾸면 화면만 요동친다.
 */
export function sameOccurrences(a: WordOccurrence[] | undefined, b: WordOccurrence[]): boolean {
  if (!a) return b.length === 0
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((record, i) => {
    const other = b[i]
    return (
      record.documentId === other.documentId &&
      record.lemma === other.lemma &&
      record.count === other.count &&
      record.recordedAt === other.recordedAt &&
      record.documentTitle === other.documentTitle &&
      record.sentence === other.sentence
    )
  })
}

/** 문서의 분절 — 일본어는 형태소 분석기가 준비되면 그것으로 한다 */
async function segmentForRecord(doc: Document): Promise<{
  segments: Segment[]
  sentences: Sentence[]
  /** lindera 경로에서만 있다 — 시작 오프셋 → 원형 */
  lemmaByStart?: Map<number, string>
  segmenter: 'lindera' | 'intl'
}> {
  if (doc.languageCode === 'ja') {
    // 문서를 여는 길목이다 — 사용자가 일본어를 보고 있으므로 사전을 받아도 된다.
    // 실패하면 Intl 로 폴백한다. 기록이 늦어질 뿐 열리지 않는 일은 없다.
    try {
      await ensureJapaneseTokenizer()
    } catch {
      /* 폴백 */
    }
    const upgrade = segmentJapanese(doc.rawText)
    if (upgrade) return { ...upgrade, segmenter: 'lindera' as const }
  }
  if (doc.languageCode === 'zh') {
    // 일본어와 같은 길목 — 중국어를 보고 있으므로 사전을 받아도 된다.
    try {
      await ensureChineseTokenizer()
    } catch {
      /* 폴백 */
    }
    const upgrade = segmentChinese(doc.rawText)
    if (upgrade) return { ...upgrade, segmenter: 'lindera' as const }
  }
  const { segments, sentences } = tokenize(doc.rawText, doc.languageCode)
  return { segments, sentences, segmenter: 'intl' as const }
}

export const useOccurrencesStore = create<OccurrencesState>((set, get) => ({
  byLanguage: {},
  occurrences: [],
  recorded: {},
  refreshing: false,

  /**
   * 이 언어의 기록을 읽는다.
   *
   * 내용이 같으면 상태를 건드리지 않는다. 동기화가 돌 때마다 이 적재가 일어나는데,
   * 새 배열 하나만 만들어져도 목록 전체가 다시 그려지고 진도 계산도 다시 돈다.
   */
  loadLanguage: async (languageCode) => {
    const rows = await idbGetAllByIndex<WordOccurrence>(
      STORES.wordOccurrences,
      'languageCode',
      languageCode,
    )
    rows.sort(sortByPosition)

    set((s) => {
      if (sameOccurrences(s.byLanguage[languageCode], rows)) return s
      const byLanguage = { ...s.byLanguage, [languageCode]: rows }
      return { byLanguage, occurrences: flatten(byLanguage) }
    })
  },

  /**
   * 현재 규칙으로 다시 계산되지 않은 문서를 되살린다.
   *
   * 한 번에 하나씩 유휴 시점에 처리한다 — 문서가 많으면 토크나이징이 무겁다.
   */
  refreshStaleDocuments: async (docs) => {
    /**
     * Only documents whose text this device holds may be recomputed.
     *
     * A metadata-only document (the list pull never carried its `raw_text`) has
     * an empty `rawText`. Tokenizing that would compute no words, and the write
     * path would replace its server occurrence rows with an empty set and push
     * it — a read action erasing data. Metadata-only documents keep the
     * server's rows; the wordbook and per-document progress are derived
     * elsewhere (projection / incremental pull).
     */
    const recomputable = docs.filter((doc) => doc.hasContent !== false)
    if (recomputable.length === 0) return 0
    // 목록과 동기화가 동시에 부를 수 있다 — 중복 계산을 막는다
    if (get().refreshing) return 0
    set({ refreshing: true })

    const meta = await idbGetAll<{ documentId: string; lemmaVersion: number; segmenter?: string }>(
      STORES.documentMeta,
    ).catch(() => [])
    // Reserved device bookkeeping (sync meta, projection state) is not a
    // document's computation record — it must never count as a known document
    const known = new Map(
      meta
        .filter((m) => !isReservedDocumentMetaId(m.documentId))
        .map((m) => [m.documentId, m] as const),
    )
    /**
     * 일본어·중국어는 분절기까지 본다 — Intl 로 기록됐는데 lindera 가 준비됐으면
     * 다시 계산한다. 준비 안 됐을 땐 건드리지 않는다. 앱 시작 시점에 사전을 받게
     * 하면 모바일 데이터를 사용자가 보지도 않은 문서에 쓰게 된다.
     */
    const stale = recomputable.filter(
      (doc) =>
        known.get(doc.id)?.lemmaVersion !== LEMMA_VERSION ||
        (doc.languageCode === 'ja' &&
          isJapaneseReady() &&
          known.get(doc.id)?.segmenter !== 'lindera') ||
        (doc.languageCode === 'zh' &&
          isChineseReady() &&
          known.get(doc.id)?.segmenter !== 'lindera'),
    )

    try {
      // meta 는 recordDocument 가 쓴다 — 여기서 또 쓰면 분절기 기록이 지워져
      // 일본어 문서가 매번 '낡은 것' 으로 남아 영영 다시 계산된다.
      for (const doc of stale) {
        await get().recordDocument(doc, true)
      }
      return stale.length
    } finally {
      set({ refreshing: false })
    }
  },

  recordDocument: async (doc, force = false) => {
    if (!force && get().recorded[doc.id]) return

    const { segments, sentences, lemmaByStart, segmenter } = await segmentForRecord(doc)
    const words = segments.filter((s) => s.type === 'word')

    /**
     * Records for one computation. A wordless document yields an empty list, and
     * the comparison below decides whether anything needs writing. That way an
     * unchanged wordless document writes nothing: no row rewrite, no new
     * `occurrencesUpdatedAt`, and therefore no sync push. A document that has
     * genuinely become wordless still has old rows, so the comparison fails and
     * the normal path clears them — which tells the server once.
     *
     * `recordedAt` is attached once, after every row has been collected.
     */
    const records: WordOccurrence[] = []
    if (words.length > 0) {
      // 문서 안에서 실제로 쓰인 표기만 보고 lemma 를 정한다 (US/us 분리 등)
      const lemmaOf = resolveLemmasFromWords(
        words.map((w) => ({
          text: w.text,
          // 문장의 첫 단어여도 문서 중간에 다시 나오면 구분 단서가 된다
          sentenceInitial: isCapitalisedPosition(doc.rawText, sentences, w.start, w.sentenceIndex),
        })),
        doc.languageCode,
      )

      /** recordedAt 은 아래에서 한꺼번에 붙인다 */
      type Draft = Omit<WordOccurrence, 'recordedAt'>
      const byLemma = new Map<string, Draft>()
      for (const word of words) {
        /**
         * 서버는 lemma·surface 를 200자까지만 받는다. 붙여넣은 URL·해시처럼
         * 공백 없이 긴 글자는 토크나이저가 한 단어로 보므로 여기서 먼저 건너뛴다.
         * 문서 전체를 버리지 않는다 — 나머지 단어는 그대로 기록한다.
         */
        if (word.text.length > MAX_WORD_LENGTH) continue

        // lindera 경로는 시작 자리로 원형을 바로 안다 — 표기가 겹쳐도 자리가 답이다
        const lemma = lemmaByStart?.get(word.start) ?? lemmaOf.get(word.text) ?? word.lemma
        // 표기뿐 아니라 해석된 lemma 도 서버 상한을 지켜야 한다
        if (lemma.length > MAX_WORD_LENGTH) continue
        const existing = byLemma.get(lemma)
        if (existing) {
          existing.count += 1
          if (!existing.surfaces.includes(word.text)) existing.surfaces.push(word.text)
          continue
        }
        byLemma.set(lemma, {
          documentId: doc.id,
          languageCode: doc.languageCode,
          lemma,
          surfaces: [word.text],
          count: 1,
          charStart: word.start,
          charEnd: word.end,
          // 서버는 문장을 5,000자까지만 받는다 — 긴 문장도 예문의 앞부분은 남긴다
          sentence: (sentences[word.sentenceIndex]?.text ?? '')
            .trim()
            .slice(0, MAX_SENTENCE_LENGTH),
          documentTitle: doc.title,
        })
      }

      const recordedAt = Date.now()
      for (const record of byLemma.values()) records.push({ ...record, recordedAt })
      records.sort(sortByPosition)
    }

    /**
     * Skip the write when the last computation is still the truth.
     *
     * Replacing rows looks like invisible work to the user, but it clears and
     * rewrites storage and makes sync treat the document as changed all the way
     * to the server. The cost grows with the number of documents. A title-only
     * rename is not an occurrence-content change either (occurrenceNoop.ts).
     */
    const existing = await idbGetAllByIndex<WordOccurrence>(
      STORES.wordOccurrences,
      'documentId',
      doc.id,
    )
    if (sameOccurrenceRecords(existing, records)) {
      await rememberUnchangedComputation(doc.id, segmenter)
      set((s) => ({ recorded: { ...s.recorded, [doc.id]: true } }))
      return
    }

    await replaceOccurrences(doc.id, records)

    /**
     * 계산을 기억한다 — 다음에 이 규칙이 바뀌면 다시 계산된다.
     *
     * **기억은 저장을 마친 뒤에 남긴다.** meta 는 '이 문서는 이 규칙으로 계산되어
     * 있다' 는 약속이라서, 약속을 먼저 남기고 저장이 실패하면 그 문서는 영영 '최신' 으로만
     * 보인다 — 다시 계산되지 않는다. 순서가 규칙의 일부다.
     */
    await idbPut(STORES.documentMeta, {
      documentId: doc.id,
      lemmaVersion: LEMMA_VERSION,
      segmenter,
      // 등장 기록을 마지막으로 쓴 시각 — 다음 동기화가 이 문서만 보낸다
      occurrencesUpdatedAt: new Date().toISOString(),
    }).catch(() => {})

    set((s) => {
      const byLanguage = mergeByLanguage(s.byLanguage, doc.languageCode, doc.id, records)
      return {
        recorded: { ...s.recorded, [doc.id]: true },
        byLanguage,
        occurrences: flatten(byLanguage),
      }
    })
  },

  forgetDocument: async (documentId) => {
    await idbDeleteByIndex(STORES.wordOccurrences, 'documentId', documentId)
    /**
     * documentMeta 는 주키가 documentId 다 — 같은 이름의 인덱스가 없다.
     *
     * 인덱스로 지우면 NotFoundError 가 나고, 그 뒤 코드가 아예 실행되지 않아
     * **기억 속 목록이 갱신되지 않았다.** 완전 삭제한 문서의 단어가 단어장에 그대로
     * 남았다 — 새로고침해야 사라졌다.
     */
    await idbDelete(STORES.documentMeta, documentId)
    set((s) => {
      const recorded = { ...s.recorded }
      delete recorded[documentId]
      const byLanguage: Record<string, WordOccurrence[]> = {}
      for (const [language, rows] of Object.entries(s.byLanguage)) {
        byLanguage[language] = rows.filter((r) => r.documentId !== documentId)
      }
      return { recorded, byLanguage, occurrences: flatten(byLanguage) }
    })
  },
}))