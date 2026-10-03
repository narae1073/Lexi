/**
 * Phase 1~5는 계정 없이 로컬에서 동작한다 (PLAN.md Phase 1).
 * 계정 동기화(Phase 6)에서 Supabase로 이전한다.
 */

const DB_NAME = 'lexi'
const DB_VERSION = 1

export const STORES = {
  documents: 'documents',
  wordStates: 'wordStates',
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

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll())
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key))
}

export function idbPut<T>(store: StoreName, value: T): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.put(value))
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<undefined> {
  return tx(store, 'readwrite', (s) => s.delete(key))
}

export function idbGetAllByIndex<T>(
  store: StoreName,
  index: string,
  key: IDBValidKey,
): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.index(index).getAll(key))
}