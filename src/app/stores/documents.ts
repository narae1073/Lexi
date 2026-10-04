import { create } from 'zustand'

import { STORES, idbDelete, idbGetAll, idbPut } from '../../lib/storage/localDb'
import { deleteDocumentRemote } from '../../lib/sync/sync'
import { useAuthStore } from './auth'
import { useOccurrencesStore } from './occurrences'
import type { Document, LanguageCode } from '../../types'

type DocumentsState = {
  documents: Document[]
  loading: boolean
  /**
   * IndexedDB 읽기가 한 번이라도 끝났는가.
   *
   * 이것이 없으면 문서 URL 로 바로 들어왔을 때 저장소가 아직 비어 있어
   * "그런 문서 없다" 고 판단하고 홈으로 튕긴다 — 적재가 시작되기 전에
   * 판단하므로 항상 튕긴다.
   */
  ready: boolean
  load: () => Promise<void>
  create: (input: {
    title: string
    languageCode: LanguageCode
    rawText: string
    /** 제목이 비었을 때 쓸 표기 — 스토어는 i18n 을 모르므로 호출부가 넘긴다 */
    fallbackTitle: string
  }) => Promise<Document>
  remove: (id: string) => Promise<void>
  /** 문서를 열어 봤음을 기록한다 — 목록에 보이는 '최근 본 시각' 의 근거 */
  touch: (id: string) => Promise<void>
}

function now(): string {
  return new Date().toISOString()
}

export const useDocumentsStore = create<DocumentsState>((set, get) => ({
  documents: [],
  loading: false,
  ready: false,

  load: async () => {
    set({ loading: true })
    const docs = await idbGetAll<Document>(STORES.documents)
    docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    set({ documents: docs, loading: false, ready: true })
  },

  /**
   * 문서를 연 시각을 찍는다.
   *
   * 이 앱에서 문서는 고치지 않는다 — 만들어서 읽기만 한다. 그래서 updated_at 은
   * '마지막으로 읽은 시각' 이라고 읽는 것이 맞다.
   */
  touch: async (id) => {
    const now = new Date().toISOString()
    const doc = get().documents.find((d) => d.id === id)
    if (!doc || doc.updatedAt === now) return

    const next = { ...doc, updatedAt: now }
    set((s) => ({ documents: s.documents.map((d) => (d.id === id ? next : d)) }))
    await idbPut(STORES.documents, next).catch((error) => {
      console.error('문서 열람 시각 저장 실패', error)
    })
  },

  remove: async (id) => {
    // 서버에도 알려야 한다 — 안 하면 다음 동기화 때 다른 기기에 다시 나타난다.
    // 로컬 삭제를 먼저 끝내는 것이 맞다: 동기화가 안 되면 사용자는 문서를 지웠는데
    // 다른 기기에 남는 것이, 지웠는데 여기에도 남는 것보다 낫다.
    await idbDelete(STORES.documents, id)
    await useOccurrencesStore.getState().forgetDocument(id)
    set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }))

    const user = useAuthStore.getState().user
    if (user) {
      try {
        await deleteDocumentRemote(user.id, id)
      } catch (error) {
        console.error('서버 문서 삭제 실패 — 다음 동기화 때 다시 지운다', error)
      }
    }
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