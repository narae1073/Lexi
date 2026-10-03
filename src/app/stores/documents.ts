import { create } from 'zustand'

import { STORES, idbGetAll, idbPut } from '../../lib/storage/localDb'
import type { Document, LanguageCode } from '../../types'

type DocumentsState = {
  documents: Document[]
  loading: boolean
  load: () => Promise<void>
  create: (input: {
    title: string
    languageCode: LanguageCode
    rawText: string
  }) => Promise<Document>
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

  create: async ({ title, languageCode, rawText }) => {
    const timestamp = now()
    const doc: Document = {
      id: crypto.randomUUID(),
      title: title.trim() || '제목 없음',
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