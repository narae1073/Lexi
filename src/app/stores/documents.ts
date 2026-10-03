import { create } from 'zustand'

import { STORES, idbDelete, idbGetAll, idbPut } from '../../lib/storage/localDb'
import { useOccurrencesStore } from './occurrences'
import type { Document, LanguageCode } from '../../types'

type DocumentsState = {
  documents: Document[]
  loading: boolean
  load: () => Promise<void>
  create: (input: {
    title: string
    languageCode: LanguageCode
    rawText: string
    /** 제목이 비었을 때 쓸 표기 — 스토어는 i18n 을 모르므로 호출부가 넘긴다 */
    fallbackTitle: string
  }) => Promise<Document>
  remove: (id: string) => Promise<void>
}

function now(): string {
  return new Date().toISOString()
}

export const useDocumentsStore = create<DocumentsState>((set) => ({
  documents: [],
  loading: false,

  load: async () => {
    set({ loading: true })
    const docs = await idbGetAll<Document>(STORES.documents)
    docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    set({ documents: docs, loading: false })
  },

  remove: async (id) => {
    await idbDelete(STORES.documents, id)
    await useOccurrencesStore.getState().forgetDocument(id)
    set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }))
  },

  create: async ({ title, languageCode, rawText, fallbackTitle }) => {
    const timestamp = now()
    const doc: Document = {
      id: crypto.randomUUID(),
      title: title.trim() || fallbackTitle,
      languageCode,
      rawText,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await idbPut(STORES.documents, doc)
    set((s) => ({ documents: [doc, ...s.documents] }))
    return doc
  },
}))