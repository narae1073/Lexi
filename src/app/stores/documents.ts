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
  /** 문서를 열어 봤음을 기록한다 — 목록에 보이는 '최근 본 시각' 의 근거 */
  touch: (id: string) => Promise<void>
  /** 제목을 바꾼다. 빈 제목은 받지 않는다 — 제목이 없는 문서는 길을 잃는다 */
  rename: (id: string, title: string) => Promise<boolean>
  /** 휴지통으로 보낸다 — 바로 지우지 않는다 */
  trash: (id: string) => Promise<void>
  /** 휴지통에서 되살린다 */
  restore: (id: string) => Promise<void>
  /** 되돌릴 수 없��� 지운다 — 등장 기록도 함께 사라진다 */
  purge: (id: string) => Promise<void>
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

  rename: async (id, title) => {
    const trimmed = title.trim()
    // 빈 제목을 받으면 목록에서 구분할 수 없다 — 거부하고 그대로 둔다
    if (!trimmed) return false
    const doc = get().documents.find((d) => d.id === id)
    if (!doc || doc.title === trimmed) return false

    const next = { ...doc, title: trimmed, updatedAt: new Date().toISOString() }
    set((s) => ({ documents: s.documents.map((d) => (d.id === id ? next : d)) }))
    await idbPut(STORES.documents, next).catch((error) => {
      console.error('문서 제목 저장 실패', error)
    })
    return true
  },

  /** 휴지통에 넣고 알린다 — 화면에서는 곧바로 사라진다 */
  trash: async (id) => {
    const doc = get().documents.find((d) => d.id === id)
    if (!doc || doc.deletedAt) return

    const now = new Date().toISOString()
    const next = { ...doc, deletedAt: now, updatedAt: now }
    set((s) => ({ documents: s.documents.map((d) => (d.id === id ? next : d)) }))
    await idbPut(STORES.documents, next).catch((error) => {
      console.error('휴지통 이동 실패', error)
    })
  },

  restore: async (id) => {
    const doc = get().documents.find((d) => d.id === id)
    if (!doc?.deletedAt) return

    const next = { ...doc, deletedAt: null, updatedAt: new Date().toISOString() }
    set((s) => ({ documents: s.documents.map((d) => (d.id === id ? next : d)) }))
    await idbPut(STORES.documents, next).catch((error) => {
      console.error('문서 복구 실패', error)
    })
  },

  /** 되돌릴 수 없��� 지운다 */
  purge: async (id) => {
    await idbDelete(STORES.documents, id)
    await useOccurrencesStore.getState().forgetDocument(id)
    set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }))

    const user = useAuthStore.getState().user
    if (user) {
      try {
        await deleteDocumentRemote(user.id, id)
      } catch (error) {
        console.error('서버 문서 삭제 실패', error)
      }
    }
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