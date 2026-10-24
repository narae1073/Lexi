import { useDocumentsStore } from '../../app/stores/documents'
import { SUPPORTED_LANGUAGE_CODES } from '../../lib/languages'
import { idbCount, idbGet, idbPut, STORES } from '../../lib/storage/localDb'
import type { Document, LanguageCode } from '../../types'
import { STARTER_STORIES, type StarterStory } from './starterStories'

/** Reserved local bookkeeping row; never syncs and never appears as a document. */
export const FIRST_RUN_MARKER_ID = '__lexi_first_run__'

export type FirstRunDocument = {
  languageCode: LanguageCode
  documentId: string
}

export type FirstRunRecord = {
  documentId: typeof FIRST_RUN_MARKER_ID
  version: 1
  documents: FirstRunDocument[]
  seededAt: string
  dismissedAt?: string
}

export type FirstRunStoryRow = {
  languageCode: LanguageCode
  document: Document
  story: StarterStory
}

let inFlight: Promise<FirstRunRecord | null> | null = null

function isFirstRunRecord(value: unknown): value is FirstRunRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<FirstRunRecord>
  return (
    record.documentId === FIRST_RUN_MARKER_ID &&
    record.version === 1 &&
    Array.isArray(record.documents) &&
    typeof record.seededAt === 'string'
  )
}

export async function readFirstRunRecord(): Promise<FirstRunRecord | undefined> {
  const row = await idbGet<unknown>(STORES.documentMeta, FIRST_RUN_MARKER_ID)
  return isFirstRunRecord(row) ? row : undefined
}

function selectedLanguages(languages: readonly string[]): LanguageCode[] {
  const supported = new Set<string>(SUPPORTED_LANGUAGE_CODES)
  return [...new Set(languages)].filter((code): code is LanguageCode => supported.has(code))
}

/**
 * Seed the first-run stories once, for the languages the user chose.
 *
 * The documents are created through the normal documents store, so they are
 * regular editable/syncable docs. Occurrence generation deliberately stays on
 * the normal open/idle path: in particular, it must not force a Japanese or
 * Chinese dictionary download while the user is still onboarding.
 */
export async function seedFirstRunStories(
  languages: readonly string[],
): Promise<FirstRunRecord | null> {
  if (inFlight !== null) return inFlight

  inFlight = (async () => {
    const existing = await readFirstRunRecord()
    if (existing) return existing

    // A pre-existing library means this is not a first run (or the user already
    // created content another way). Never add starter documents on top of it.
    if ((await idbCount(STORES.documents)) > 0) return null

    const selected = selectedLanguages(languages)
    if (selected.length === 0) return null

    const created: FirstRunDocument[] = []
    for (const languageCode of selected) {
      const story = STARTER_STORIES[languageCode]
      try {
        const document = await useDocumentsStore.getState().create({
          title: story.title,
          languageCode,
          rawText: story.body,
          fallbackTitle: story.title,
        })
        created.push({ languageCode, documentId: document.id })
      } catch (error) {
        // One failed document must not prevent the other selected languages
        // from having their welcome content.
        console.error('첫 실행 이야기 만들기 실패', error)
      }
    }

    if (created.length === 0) return null

    const record: FirstRunRecord = {
      documentId: FIRST_RUN_MARKER_ID,
      version: 1,
      documents: created,
      seededAt: new Date().toISOString(),
    }
    await idbPut(STORES.documentMeta, record)
    return record
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/** Resolve the marker against the live library, dropping deleted stories. */
export function resolveFirstRunStories(
  record: FirstRunRecord,
  documents: readonly Document[],
): FirstRunStoryRow[] {
  const byId = new Map(
    documents.filter((doc) => !doc.deletedAt).map((doc) => [doc.id, doc] as const),
  )
  const rows: FirstRunStoryRow[] = []
  for (const entry of record.documents) {
    const document = byId.get(entry.documentId)
    const story = STARTER_STORIES[entry.languageCode]
    if (!document || !story) continue
    rows.push({ languageCode: entry.languageCode, document, story })
  }
  return rows
}

export async function dismissFirstRunWelcome(): Promise<void> {
  const record = await readFirstRunRecord()
  if (!record || record.dismissedAt) return
  await idbPut(STORES.documentMeta, {
    ...record,
    dismissedAt: new Date().toISOString(),
  })
}
