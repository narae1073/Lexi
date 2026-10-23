import { create } from 'zustand'

import { STORES, idbDelete, idbGet, idbGetAll, idbPut } from '../../lib/storage/localDb'
import { markPurged, putDocumentTombstone } from '../../lib/storage/purged'
import { openDocumentContent, type OpenedDocument } from '../../lib/sync/content'
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
  /**
   * 문서를 연다 — 본문을 (필요하면 한 번 받아) 돌려주고 열람 시각만 남긴다.
   *
   * 여는 일은 내용을 고치는 일이 아니다. 서버에는 `touch_document` 만 부르고,
   * 이 기기의 `lastOpenedAt` 은 조용히(동기화 변경으로 세지 않고) 적는다.
   * 본문을 문서 행에 되쓰지도 않는다 — 본문 사본은 `documentContent` 저장소에 있다.
   */
  open: (id: string) => Promise<OpenedDocument | undefined>
  /**
   * 문서를 폴더로 옮긴다. 폴더에 없애는 것도 같은 길이다 (folderId = null).
   *
   * 옮기는 일은 열람이 아니므로 updated_at 을 건드리지 않는다 — '마지막으로 본
   * 시각'은 목록 학돈 날짜·정렬의 근거다. 언제 옮겼는지는 folderUpdatedAt 이 따로
   * 찍고, 병합은 그 인장으로 늦게 옮긴 쪽을 고른다.
   */
  moveToFolder: (ids: readonly string[], folderId: string | null) => Promise<void>
  /** 제목을 바꾼다. 빈 제목은 받지 않는다 — 제목이 없는 문서는 길을 잃는다 */
  rename: (id: string, title: string) => Promise<boolean>
  /** 휴지통으로 보낸다 — 바로 지우지 않는다 */
  trash: (id: string) => Promise<void>
  /** 휴지통에서 되살린다 */
  restore: (id: string) => Promise<void>
  /** 되돌릴 수 없는 것을 지운다 — 등장 기록도 함께 사라진다 */
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
      // 본문을 아직 받지 않았는지, 받은 본문이 어느 버전인지도 목록의 말이다
      (doc.hasContent ?? true) === (other.hasContent ?? true) &&
      (doc.charCount ?? null) === (other.charCount ?? null) &&
      (doc.contentUpdatedAt ?? null) === (other.contentUpdatedAt ?? null) &&
      (doc.occurrencesUpdatedAt ?? null) === (other.occurrencesUpdatedAt ?? null) &&
      (doc.lastOpenedAt ?? null) === (other.lastOpenedAt ?? null) &&
      doc.createdAt === other.createdAt &&
      doc.updatedAt === other.updatedAt &&
      (doc.deletedAt ?? null) === (other.deletedAt ?? null) &&
      // 폴더는 문서의 내용이 아니지만 목록에 그대로 보인다 — 따라오지 않으면
      // 동기화가 옮김을 반영할 때 화면만 옛 집에 머문다
      (doc.folderId ?? null) === (other.folderId ?? null)
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

  /** 되돌릴 수 없는 것을 지운다 */
  /**
   * 되돌릴 수 없는 것을 지운다.
   *
   * **화면에서 먼저 뺀다.** 예전엔 저장을 다 끝낸 뒤 화면에서 뺐는데, 중간 한 단계가
   * 실패하면 그 뒤를 아예 실행하지 않아 눌렀는데도 남아 있었다 — 새로고침해야 사라졌다.
   * 누른 즉시 사라져야 하고, 저장은 그다음에 따라잡으면 된다.
   *
   * 지웠다고 기억해 두는 것도 여기서 한다 — 동기화가 서버를 읽는 사이에 삭제 요청이
   * 도착하지 않았으면 지운 문서가 그대로 돌아온다 (purged.ts).
   */
  purge: async (id) => {
    markPurged(id)
    await putDocumentTombstone(id).catch((error) => {
      console.error('문서 묘비 저장 실패', error)
    })
    set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }))

    try {
      await idbDelete(STORES.documents, id)
    } catch (error) {
      console.error('문서 저장 지우기 실패', error)
    }

    try {
      await useOccurrencesStore.getState().forgetDocument(id)
    } catch (error) {
      console.error('등장 기록 지우기 실패', error)
    }

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
   * 문서를 연다.
   *
   * 본문 해석은 `openDocumentContent` 가 맡는다 (로컬 사본 → 이 기기에 이미 있는
   * 본문 → 서버). 여기서는 열람 시각만 이 기기에 남긴다.
   *
   * **조용히 쓴다.** 열기는 사용자가 고친 내용이 아니므로 동기화 변경으로 세면
   * 안 된다. 서버는 `touch_document` 가 `last_opened_at` 만 찍고, 다음 메타데이터
   * 동기화가 그 값을 그대로 가져온다.
   */
  open: async (id) => {
    const doc = get().documents.find((d) => d.id === id)
    if (!doc) return undefined

    const opened = await openDocumentContent({ document: doc })
    if (opened.lastOpenedAt !== null && opened.lastOpenedAt !== (doc.lastOpenedAt ?? null)) {
      const stored = await idbGet<Document>(STORES.documents, id)
      if (stored !== undefined) {
        const next = { ...stored, lastOpenedAt: opened.lastOpenedAt }
        await idbPut(STORES.documents, next, { silent: true }).catch((error) => {
          console.error('문서 열람 시각 저장 실패', error)
        })
      }
      set((s) => ({
        documents: s.documents.map((d) =>
          d.id === id ? { ...d, lastOpenedAt: opened.lastOpenedAt } : d,
        ),
      }))
    }
    return opened
  },

  /**
   * 문서를 폴더로 옮긴다. 폴더에 없애는 것도 같은 길이다 (folderId = null).
   *
   * **updated_at 을 건드리지 않는다** — 이 앱에서 그 시각은 '마지막으로 본
   * 시각'이고 목록의 날짜·'최근 본 순' 정렬의 근거다. 폴더로 옮기는 일이 그
   * 시각을 찍으면, 옮긴 문서가 조용히 목록 맨 위로 술렁인다. 언제 옮겼는지는
   * folderUpdatedAt 이 따로 찍고, 병합은 그 인장으로 늦게 옮긴 쪽을 고른다.
   *
   * 개수로 받는 이유: 한 장을 옮기는 것과 골라서 여러 장을 옮기는 것(Phase 3)이
   * 같은 길이다 — 같은 말을 두 곳에서 하지 않게.
   */
  moveToFolder: async (ids, folderId) => {
    const stamp = now()
    const moving = new Set(ids)

    const updates = get().documents
      .filter((doc) => moving.has(doc.id))
      .filter((doc) => (doc.folderId ?? null) !== folderId)
      .map((doc) => ({ ...doc, folderId, folderUpdatedAt: stamp }))
    if (updates.length === 0) return

    // 화면을 먼저 옮긴다 — 저장은 따라 잡는다 (purge 의 규칙과 같다)
    set((s) => ({
      documents: s.documents.map((doc) => {
        const update = updates.find((u) => u.id === doc.id)
        return update ?? doc
      }),
    }))
    for (const doc of updates) {
      await idbPut(STORES.documents, doc).catch((error) => {
        console.error('문서 폴더 옮기기 실패', error)
      })
    }
  },

  create: async ({ title, languageCode, rawText, fallbackTitle }) => {
    const timestamp = now()
    const doc: Document = {
      id: crypto.randomUUID(),
      title: title.trim() || fallbackTitle,
      languageCode,
      rawText,
      // 이 기기에서 만든 문서는 본문을 이미 들고 있다 — 목록 길이도 바로 안다
      charCount: rawText.length,
      hasContent: true,
      contentUpdatedAt: null,
      lastOpenedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await idbPut(STORES.documents, doc)
    set((s) => ({ documents: [doc, ...s.documents] }))
    return doc
  },
}))