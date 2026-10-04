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

/**
 * 두 목록이 같은 내용인지 — 같은데 갈아끼우지 않기 위한 판단.
 *
 * 화면에 보이는 것을 모두 비교한다. updatedAt 만 보면 빠르지만, 제목을 바꿀 때
 * updatedAt 이 함께 올라가므로 그것만으로는 '제목이 같나' 를 알 수 없다.
 */
export function sameDocuments(a: Document[], b: Document[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((doc, i) => {
    const other = b[i]
    return (
      doc.id === other.id &&
      doc.title === other.title &&
      doc.languageCode === other.languageCode &&
      doc.rawText === other.rawText &&
      doc.createdAt === other.createdAt &&
      doc.updatedAt === other.updatedAt &&
      (doc.deletedAt ?? null) === (other.deletedAt ?? null)
    )
  })
}

export const useDocumentsStore = create<DocumentsState>((set, get) => ({
  documents: [],
  loading: false,
  ready: false,

  /**
   * IndexedDB 에서 문서를 읽는다.
   *
   * 두 가지를 주의한다.
   *
   * 첫째, '불러오는 중' 은 첫 적재에서만 보인다. 동기화가 끝날 때마다 이 적재를
   * 다시 하는데, 그때까지 목록을 '불러오는 중' 으로 비우면 화면이 깜빡인다 — 이제
   * 동기화가 자주 돌아니 읽는 내내 깜빡였다. 데이터는 이미 있으므로 지울 이유가 없다.
   *
   * 둘째, 내용이 같으면 배열을 갈아끼우지 않는다. 새 배열 하나에 목록 전체가 새로
   * 그려지고, 진도 게이지 계산까지 다시 돈다. 동기화가 1.2초마다 돌아도 아무 일도
   * 없도록 해야 한다.
   */
  load: async () => {
    if (!get().ready) set({ loading: true })

    const docs = await idbGetAll<Document>(STORES.documents)
    docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    set((s) =>
      sameDocuments(s.documents, docs)
        ? { loading: false, ready: true }
        : { documents: docs, loading: false, ready: true },
    )
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