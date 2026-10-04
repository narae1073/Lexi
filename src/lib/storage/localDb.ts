/**
 * Phase 1~5는 계정 없이 로컬에서 동작한다 (PLAN.md Phase 1).
 * 계정 동기화(Phase 6)에서 Supabase로 이전한다.
 */

const DB_NAME = 'lexi'
const DB_VERSION = 4

export const STORES = {
  documents: 'documents',
  wordStates: 'wordStates',
  /** 단어가 실제로 등장한 위치. 단어장의 "이 문서에서 본 단어" 를 만드는 원본 데이터 */
  wordOccurrences: 'wordOccurrences',
  /**
   * 번역·사전 응답의 기기 사본.
   *
   * 서버 캐시가 있어도 서버에 닿아야 한다. 네트워크가 끊기면 아무것도 못 보므로,
   * 받아 본 응답을 이 기기에도 남겨 두는 유일한 방법이다 (PLAN.md 결정 4).
   */
  responseCache: 'responseCache',
  /**
   * 문서별 표기 규칙 버전 (documentMeta).
   *
   * 서버로 보내지 않는다 — 기기 안에서만 bookkeeping 하는 용도다.
   * 등장 기록은 서버에도 있으므로, "이 기기에서 이 규칙으로 다시 계산했는가"
   * 만 알면 언제든 다시 계산할 수 있다.
   */
  documentMeta: 'documentMeta',
} as const

export type StoreName = (typeof STORES)[keyof typeof STORES]

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.documents)) {
        const s = db.createObjectStore(STORES.documents, { keyPath: 'id' })
        s.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORES.wordStates)) {
        const s = db.createObjectStore(STORES.wordStates, { keyPath: ['languageCode', 'lemma'] })
        s.createIndex('languageCode', 'languageCode')
      }
      if (!db.objectStoreNames.contains(STORES.documentMeta)) {
        db.createObjectStore(STORES.documentMeta, { keyPath: 'documentId' })
      }
      if (!db.objectStoreNames.contains(STORES.responseCache)) {
        const s = db.createObjectStore(STORES.responseCache, { keyPath: 'key' })
        s.createIndex('cachedAt', 'cachedAt')
      }
      if (!db.objectStoreNames.contains(STORES.wordOccurrences)) {
        const s = db.createObjectStore(STORES.wordOccurrences, {
          keyPath: ['documentId', 'lemma'],
        })
        s.createIndex('languageCode', 'languageCode')
        s.createIndex('lemma', 'lemma')
        s.createIndex('documentId', 'documentId')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  return dbPromise
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const req = run(transaction.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key))
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll())
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<undefined> {
  return tx(store, 'readwrite', (s) => s.delete(key))
}

export function idbPut<T>(store: StoreName, value: T): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.put(value))
}

/**
 * 인덱스에서 특정 값 이하인 항목을 모두 지운다.
 *
 * 응답 캐시는 무한정 쌓이므로 필요할 때 훑어 버린다.
 * idbDeleteByIndex 가 하는 '정확히 그 키' 삭제가 아니라 범위 삭제라는 점이 다르다.
 */
export function idbDeleteByIndexRange(
  store: StoreName,
  index: string,
  upperBound: IDBValidKey,
): Promise<number> {
  return openDb().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite')
        const req = transaction.objectStore(store).index(index).openCursor(IDBKeyRange.upperBound(upperBound))
        let removed = 0
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          cursor.delete()
          removed += 1
          cursor.continue()
        }
        req.onerror = () => reject(req.error)
        transaction.oncomplete = () => resolve(removed)
        transaction.onabort = () => reject(transaction.error)
      }),
  )
}

/** 문서 하나의 등장 기록을 통째로 교체한다 (재저장 시 낡은 행이 남지 않게). */
export async function replaceOccurrences<T>(
  documentId: string,
  records: T[],
): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES.wordOccurrences, 'readwrite')
    const store = transaction.objectStore(STORES.wordOccurrences)
    const index = store.index('documentId')

    const cursorReq = index.openCursor(IDBKeyRange.only(documentId))
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
        return
      }
      for (const record of records) store.put(record)
    }

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export function idbDeleteByIndex(
  store: StoreName,
  index: string,
  key: IDBValidKey,
): Promise<void> {
  return tx<void>(store, 'readwrite', (s) => {
    const req = s.index(index).openKeyCursor(IDBKeyRange.only(key))
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        s.delete(cursor.primaryKey)
        cursor.continue()
      }
    }
    // KeyCursor 에 delete 가 없으므로 결과를 그대로 돌려준다
    return req as unknown as IDBRequest<void>
  }).then(() => undefined)
}

export function idbGetAllByIndex<T>(
  store: StoreName,
  index: string,
  key: IDBValidKey,
): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.index(index).getAll(key))
}