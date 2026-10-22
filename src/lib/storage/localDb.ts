/**
 * Phase 1~5는 계정 없이 로컬에서 동작한다 (PLAN.md Phase 1).
 * 계정 동기화(Phase 6)에서 Supabase로 이전한다.
 */

import type { DirtyKey, LocalSyncMeta } from '../sync/types'

const DB_NAME = 'lexi'
/**
 * Local DB schema version.
 *
 * **Never bump for sync bookkeeping** — Release 2 stores the reserved
 * `LocalSyncMeta` record inside the existing `documentMeta` store precisely so
 * this stays 6: the previous frontend must keep opening a database this build
 * has touched (a version 7 open would fail with VersionError after a rollback).
 */
export const DB_VERSION = 6

/**
 * `documentId` of the reserved `LocalSyncMeta` record in `STORES.documentMeta`.
 *
 * A reserved id instead of a new store/new version: documentMeta is local-only
 * (never sent to the server), so it is the right home for device bookkeeping.
 */
export const SYNC_META_KEY = '__lexi_sync_meta__'

export const STORES = {
  documents: 'documents',
  folders: 'folders',
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
  /**
   * 완전 삭제한 문서의 묘비 — 계정으로 동기화된다.
   *
   * 문서 행이 서버에서 사라진 것을 다른 기기가 '이 기기에만 있는 문서' 로 오해해
   * 다시 올리면 완전 삭제가 무효가 된다. 지운 사실을 남겨 되살아나지 않게 한다.
   */
  documentTombstones: 'documentTombstones',
} as const

export type StoreName = (typeof STORES)[keyof typeof STORES]

/**
 * 서버로 보내야 하는 저장소.
 *
 * 여기가 바뀐 것은 이 기기 밖에 있는 계정에도 반영되어야 한다. 응답 캐시는 기기 안에서
 * 재사용용이고, documentMeta 는 기기 안의 계산 기록이라 서버와 상관없다.
 */
/** 폴더 — 문서를 모으는 자리. 문서·상태와 함께 계정 동기화 대상이다 */
const SYNCED_STORES: readonly StoreName[] = [
  'documents',
  'folders',
  'wordStates',
  'wordOccurrences',
  'documentTombstones',
]

/**
 * Listener for finished local writes to synced stores.
 *
 * The reserved sync-meta record travels with the signal: the bump has already
 * happened in the same transaction as the write, so listeners can trust
 * `meta.pendingByStore`/`meta.revision` without re-reading the database.
 */
type LocalWriteListener = (store: StoreName, meta: LocalSyncMeta) => void

const writeListeners = new Set<LocalWriteListener>()

/**
 * 이 기기에 저장된 학습 데이터가 바뀌었음을 알린다.
 *
 * 쓰기는 tx() 하나를 지나는데, 거기서 한 번만 알린다. 그래서 동기화가 필요한 지점을
 * 빠뜨릴 수 없다 — 단어를 표시하거나 문서를 고치는 코드가 늘어도 저절로 따라온다.
 */
export function onLocalWrite(listener: LocalWriteListener): () => void {
  writeListeners.add(listener)
  return () => {
    writeListeners.delete(listener)
  }
}

function notifyLocalWrite(store: StoreName, meta: LocalSyncMeta) {
  if (!SYNCED_STORES.includes(store)) return
  for (const listener of writeListeners) {
    try {
      listener(store, meta)
    } catch (error) {
      // 알림에 실패해도 저장은 끝난 일이다 — 저장을 막지 않는다
      console.error('저장 완료 알림 실패', error)
    }
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Normalizes whatever sits under the reserved key into a usable meta record.
 *
 * A missing or malformed row yields null — callers decide whether to mint a
 * fresh epoch. Bookkeeping restarts rather than trusting a half-written record.
 */
function normalizeSyncMeta(stored: unknown): LocalSyncMeta | null {
  if (typeof stored !== 'object' || stored === null) return null
  const row = stored as Partial<LocalSyncMeta>
  if (row.documentId !== SYNC_META_KEY) return null
  if (typeof row.epoch !== 'string' || row.epoch === '') return null
  if (typeof row.revision !== 'number' || !Number.isFinite(row.revision) || row.revision < 0) {
    return null
  }
  return {
    documentId: SYNC_META_KEY,
    epoch: row.epoch,
    revision: row.revision,
    pendingByStore: row.pendingByStore ?? {},
    dirty: row.dirty ?? {},
  }
}

/** A brand-new meta record — a fresh epoch is minted with the database. */
function freshSyncMeta(): LocalSyncMeta {
  return {
    documentId: SYNC_META_KEY,
    epoch: crypto.randomUUID(),
    revision: 0,
    pendingByStore: {},
    dirty: {},
  }
}

/**
 * The meta after one user write: `revision + 1`, one more pending count for the
 * store, and the dirty key at the new revision. Pure — callers apply it inside
 * their transaction so the bump cannot drift from the write it belongs to.
 */
function bumpedSyncMeta(
  meta: LocalSyncMeta,
  store: StoreName,
  key: string | undefined,
): LocalSyncMeta {
  const revision = meta.revision + 1
  const pendingByStore = {
    ...meta.pendingByStore,
    [store]: (meta.pendingByStore[store] ?? 0) + 1,
  }
  const dirty = { ...meta.dirty }
  if (key !== undefined) {
    dirty[store] = { ...(dirty[store] ?? {}), [key]: revision }
  }
  return { ...meta, revision, pendingByStore, dirty }
}

/**
 * Dirty-key encoding per synced store (plan "Clock-safe dirty keys"):
 * documents/folders/tombstones → row id; wordStates → `languageCode\0lemma`;
 * wordOccurrences → document id (the push unit is a document).
 * Returns undefined when the row does not carry its key — the write still
 * bumps revision and pending, just without a dirty entry.
 */
function dirtyKeyForValue(store: StoreName, value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (store === STORES.documents || store === STORES.folders) {
    return typeof row.id === 'string' ? row.id : undefined
  }
  if (store === STORES.wordOccurrences || store === STORES.documentTombstones) {
    return typeof row.documentId === 'string' ? row.documentId : undefined
  }
  if (store === STORES.wordStates) {
    return typeof row.languageCode === 'string' && typeof row.lemma === 'string'
      ? `${row.languageCode}\u0000${row.lemma}`
      : undefined
  }
  return undefined
}

/** Same encoding for a delete, where only the target key is known. */
function dirtyKeyForKey(store: StoreName, key: IDBValidKey): string | undefined {
  if (store === STORES.wordStates) {
    if (Array.isArray(key) && typeof key[0] === 'string' && typeof key[1] === 'string') {
      return `${key[0]}\u0000${key[1]}`
    }
    return typeof key === 'string' ? key : undefined
  }
  if (store === STORES.wordOccurrences) {
    // The primary key is [documentId, lemma]; the push unit is the document
    if (Array.isArray(key) && typeof key[0] === 'string') return key[0]
    return typeof key === 'string' ? key : undefined
  }
  return typeof key === 'string' ? key : undefined
}

/**
 * Runs one readwrite transaction over the reserved sync-meta record: reads the
 * current meta, lets `update` compute the next value and persist it, and
 * resolves with the update's result after commit.
 *
 * Reading and writing inside a single transaction is what makes the revision
 * reliable — a concurrent user write in another transaction can never slip
 * between the read and the write.
 */
function withSyncMeta<T>(update: (meta: LocalSyncMeta, metaStore: IDBObjectStore) => T): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORES.documentMeta, 'readwrite')
        const metaStore = transaction.objectStore(STORES.documentMeta)
        const getReq = metaStore.get(SYNC_META_KEY)
        let result: T | undefined
        getReq.onsuccess = () => {
          const meta = normalizeSyncMeta(getReq.result) ?? freshSyncMeta()
          result = update(meta, metaStore)
        }
        transaction.oncomplete = () => {
          if (result === undefined) {
            reject(new Error('로컬 동기화 기록 트랜잭션이 완료되지 않았습니다'))
            return
          }
          resolve(result)
        }
        transaction.onerror = () => {
          // onabort follows with the error — do not reject twice here
        }
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('로컬 동기화 기록 트랜잭션이 중단되었습니다'))
      }),
  )
}

/** Reads the reserved sync-meta record; null when it does not exist yet. */
export async function readLocalSyncMeta(): Promise<LocalSyncMeta | null> {
  const stored = await idbGet<unknown>(STORES.documentMeta, SYNC_META_KEY)
  return stored === undefined ? null : normalizeSyncMeta(stored)
}

/**
 * Returns the reserved sync-meta record, creating it on first use.
 *
 * Repeated calls reuse the stored record, so the epoch survives reloads and
 * upgrades; it changes only when the whole database is deleted and recreated.
 */
export function ensureLocalSyncMeta(): Promise<LocalSyncMeta> {
  return withSyncMeta((meta, metaStore) => {
    metaStore.put(meta)
    return meta
  })
}

/**
 * Bumps the local revision for one user write of `store` (optionally naming the
 * dirty key). Prefer the write helpers (`idbPut`/`idbDelete`/…) which bump in
 * the same transaction as the row itself; this exists for callers that must
 * bump on their own.
 */
export function bumpLocalRevision(store: StoreName, key?: string): Promise<LocalSyncMeta> {
  return withSyncMeta((meta, metaStore) => {
    const next = bumpedSyncMeta(meta, store, key)
    metaStore.put(next)
    return next
  })
}

/** Current local revision; 0 before the first user write. */
export async function readLocalRevision(): Promise<number> {
  return (await readLocalSyncMeta())?.revision ?? 0
}

/** All dirty keys with the revision of their last local write. */
export async function readDirtyKeys(): Promise<DirtyKey[]> {
  const meta = await readLocalSyncMeta()
  if (meta === null) return []
  const keys: DirtyKey[] = []
  for (const store of Object.keys(meta.dirty) as StoreName[]) {
    for (const [key, revision] of Object.entries(meta.dirty[store] ?? {})) {
      keys.push({ store, key, revision })
    }
  }
  return keys
}

/**
 * Clears one dirty key only if it still sits at `revision`.
 *
 * A write that landed after the push was planned has a newer revision and must
 * stay dirty — clearing at a stale revision returns false and removes nothing.
 */
export function clearDirtyIfRevision(
  store: StoreName,
  key: string,
  revision: number,
): Promise<boolean> {
  return withSyncMeta((meta, metaStore) => {
    if (meta.dirty[store]?.[key] !== revision) return false
    const byKey = { ...(meta.dirty[store] ?? {}) }
    delete byKey[key]
    const dirty = { ...meta.dirty }
    if (Object.keys(byKey).length > 0) dirty[store] = byKey
    else delete dirty[store]
    metaStore.put({ ...meta, dirty })
    return true
  })
}

/**
 * Subtracts a pushed batch from the pending counts.
 *
 * Only the counted-at-sync-start batch is subtracted (clamped at zero), so
 * writes that landed while the sync was running stay pending for the next one.
 * The revision and the dirty journal are not touched.
 */
export function subtractPending(
  batch: Partial<Record<StoreName, number>>,
): Promise<LocalSyncMeta> {
  return withSyncMeta((meta, metaStore) => {
    const pendingByStore = { ...meta.pendingByStore }
    for (const store of Object.keys(batch) as StoreName[]) {
      const count = batch[store]
      if (typeof count !== 'number' || count <= 0) continue
      const left = (pendingByStore[store] ?? 0) - count
      if (left > 0) pendingByStore[store] = left
      else delete pendingByStore[store]
    }
    const next = { ...meta, pendingByStore }
    metaStore.put(next)
    return next
  })
}

/**
 * 초기화가 진행 중인 동안 새 연결을 열지 않는다.
 *
 * deleteLocalDatabase 가 캐시를 비운 뒤 연결을 닫는 사이에 백그라운드 읽기가
 * openDb() 를 부르면, 아무도 닫지 않을 새 연결이 생겨 삭제가 blocked 로 끝난다.
 * 그 연결은 deleteLocalDatabase 도 모르므로 영영 닫히지 않는다.
 */
let resetInProgress = false

function openDb(): Promise<IDBDatabase> {
  if (resetInProgress) {
    return Promise.reject(
      new Error('로컬 데이터베이스를 초기화하는 중입니다. 잠시 후 다시 시도해 주세요.'),
    )
  }
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.documents)) {
        const s = db.createObjectStore(STORES.documents, { keyPath: 'id' })
        s.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORES.folders)) {
        // 문서 정리의 원본 데이터다 — 문서와 함께 계정으로 간다 (문서 휴지통과 같은 모양)
        const s = db.createObjectStore(STORES.folders, { keyPath: 'id' })
        s.createIndex('updatedAt', 'updatedAt')
        s.createIndex('parentId', 'parentId')
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
      if (!db.objectStoreNames.contains(STORES.documentTombstones)) {
        db.createObjectStore(STORES.documentTombstones, { keyPath: 'documentId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  return dbPromise
}

type WriteOptions = {
  /**
   * 저장 완료 알림을 보내지 않는다.
   *
   * 동기화가 서버에서 받은 것을 되돌려 쓸 때 쓴다. 그 쓰기까지 '아직 못 올린
   * 변경' 으로 세면, 받은 것이 두 배로 보이고 동기화가 자기 자신을 다시 예약한다.
   * 사용자가 직접 한 저장은 절대 조용하지 않다.
   */
  silent?: boolean
}

/** Internal write plan: the dirty key a non-silent user write must record. */
type TxOptions = WriteOptions & { dirtyKey?: string }

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
  options?: TxOptions,
) {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        /**
         * A user write to a synced store bumps the reserved sync-meta record in
         * the SAME transaction as the row itself. The revision is the
         * interlock that protects local edits from a stale sync plan — a
         * best-effort bump after the fact could not be trusted.
         */
        const bumpMeta = mode === 'readwrite' && !options?.silent && SYNCED_STORES.includes(store)
        const transaction = bumpMeta
          ? db.transaction([STORES.documentMeta, store], 'readwrite')
          : db.transaction(store, mode)

        if (!bumpMeta) {
          // Silent sync writes and device-local stores never count as user
          // writes: no bump, no signal.
          const req = run(transaction.objectStore(store))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
          return
        }

        let result: T
        let settled = false
        let bumped: LocalSyncMeta | undefined
        const metaStore = transaction.objectStore(STORES.documentMeta)
        const getReq = metaStore.get(SYNC_META_KEY)
        getReq.onsuccess = () => {
          bumped = bumpedSyncMeta(
            normalizeSyncMeta(getReq.result) ?? freshSyncMeta(),
            store,
            options?.dirtyKey,
          )
          metaStore.put(bumped)
          const req = run(transaction.objectStore(store))
          req.onsuccess = () => {
            settled = true
            result = req.result
          }
          // A failed request aborts the transaction on its own — onabort rejects
          req.onerror = () => {}
        }
        transaction.oncomplete = () => {
          // 커밋된 뒤에 알린다 — 아직 저장되지 않은 것을 '저장됐다' 고 알리면 안 된다
          if (bumped !== undefined) notifyLocalWrite(store, bumped)
          if (!settled) {
            reject(new Error('로컬 데이터베이스 트랜잭션이 완료되지 않았습니다'))
            return
          }
          resolve(result)
        }
        transaction.onerror = () => {
          // onabort follows with the error — do not reject twice here
        }
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('로컬 데이터베이스 트랜잭션이 중단되었습니다'))
      }),
  )
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key))
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll())
}

/** 저장소에 든 행 수. 읽기 전용 트랜잭션이라 저장 완료 알림을 보내지 않는다. */
export function idbCount(store: StoreName): Promise<number> {
  return tx<number>(store, 'readonly', (s) => s.count())
}

export function idbDelete(
  store: StoreName,
  key: IDBValidKey,
  options?: WriteOptions,
): Promise<undefined> {
  return tx(store, 'readwrite', (s) => s.delete(key), {
    ...options,
    dirtyKey: SYNCED_STORES.includes(store) ? dirtyKeyForKey(store, key) : undefined,
  })
}

export function idbPut<T>(
  store: StoreName,
  value: T,
  options?: WriteOptions,
): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.put(value), {
    ...options,
    dirtyKey: SYNCED_STORES.includes(store) ? dirtyKeyForValue(store, value) : undefined,
  })
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

/**
 * 문서 하나의 등장 기록을 통째로 교체한다 (재저장 시 낡은 행이 남지 않게).
 *
 * A user recomputation (a non-silent write) bumps the revision, the pending
 * count, and the dirty key (wordOccurrences, document id) in the same
 * transaction. The sync path must call this with `{ silent: true }` — rows
 * received from the server must never count as unpushed changes.
 */
export async function replaceOccurrences<T>(
  documentId: string,
  records: T[],
  options?: WriteOptions,
): Promise<void> {
  const bumpMeta = !options?.silent
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = bumpMeta
      ? db.transaction([STORES.documentMeta, STORES.wordOccurrences], 'readwrite')
      : db.transaction(STORES.wordOccurrences, 'readwrite')
    const store = transaction.objectStore(STORES.wordOccurrences)
    const index = store.index('documentId')

    let bumped: LocalSyncMeta | undefined
    if (bumpMeta) {
      const metaStore = transaction.objectStore(STORES.documentMeta)
      const getReq = metaStore.get(SYNC_META_KEY)
      getReq.onsuccess = () => {
        bumped = bumpedSyncMeta(
          normalizeSyncMeta(getReq.result) ?? freshSyncMeta(),
          STORES.wordOccurrences,
          documentId,
        )
        metaStore.put(bumped)
      }
    }

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
    // A failed cursor request aborts the transaction on its own — onabort rejects
    cursorReq.onerror = () => {}

    transaction.oncomplete = () => {
      // Notify after commit — a user recomputation counts as pending work
      if (bumped !== undefined) notifyLocalWrite(STORES.wordOccurrences, bumped)
      resolve()
    }
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/**
 * 인덱스에서 그 값을 가진 것을 모두 지운다.
 *
 * **트랜잭션을 직접 연다.** `tx()` 로 돌리면 안 된다 — `tx()` 는 `run()` 이 돌려준
 * 요청에 `onsuccess` 를 다시 붙이는데, 여기가 필요한 커서의 동작을 그대로 덮어쓴다.
 * 덮어써진 쪽이 실행되지 않으므로 **아무것도 지워지지 않고 조용히 성공한 것처럼 보인다.**
 *
 * 실제로 그랬다: 완전 삭제한 문서의 등장 기록이 저장소에 그대로 남았고, 그래서
 * 단어장에도 남았다.
 */
export function idbDeleteByIndex(
  store: StoreName,
  index: string,
  key: IDBValidKey,
  options?: WriteOptions,
): Promise<void> {
  const bumpMeta = !options?.silent && SYNCED_STORES.includes(store)
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = bumpMeta
          ? db.transaction([STORES.documentMeta, store], 'readwrite')
          : db.transaction(store, 'readwrite')
        const objectStore = transaction.objectStore(store)
        const req = objectStore.index(index).openKeyCursor(IDBKeyRange.only(key))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          // KeyCursor 에 delete 가 없으므로 본 저장소로 지운다
          objectStore.delete(cursor.primaryKey)
          cursor.continue()
        }

        let bumped: LocalSyncMeta | undefined
        if (bumpMeta) {
          const metaStore = transaction.objectStore(STORES.documentMeta)
          const getReq = metaStore.get(SYNC_META_KEY)
          getReq.onsuccess = () => {
            bumped = bumpedSyncMeta(
              normalizeSyncMeta(getReq.result) ?? freshSyncMeta(),
              store,
              dirtyKeyForKey(store, key),
            )
            metaStore.put(bumped)
          }
        }

        transaction.oncomplete = () => {
          // Notify after commit — a user deletion counts as pending work. Silent
          // writes and device-local stores get no signal (notifyLocalWrite skips them).
          if (bumped !== undefined) notifyLocalWrite(store, bumped)
          resolve()
        }
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }),
  )
}

export function idbGetAllByIndex<T>(
  store: StoreName,
  index: string,
  key: IDBValidKey,
): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.index(index).getAll(key))
}

/**
 * 이 기기에 남은 "학습 데이터" 를 세는 대상.
 *
 * 응답 캐시와 documentMeta 는 뺀다 — 사전을 한 번 보거나 규칙 버전을 적어 둔 것은
 * 학습한 내용이 아니다. 이 둘만 있는 기기를 계정에 붙이면 빈 기기를 옮기는 셈이다.
 * SYNCED_STORES 와 지금은 같은 목록이지만 뜻이 다르므로 따로 둔다.
 */
const LEARNING_STORES: readonly StoreName[] = [
  'documents',
  'folders',
  'wordStates',
  'wordOccurrences',
  'documentTombstones',
]

/**
 * 이 기기에 학습 데이터가 하나라도 있는지.
 *
 * 계정 주인 표시가 없는 기기(익명으로 쓰던 기기)를 새 계정에 붙일지 정할 때 쓴다.
 * 하나라도 있으면 사용자가 만든 것으로 보고 함부로 지우지 않는다.
 */
export async function hasLocalLearningData(): Promise<boolean> {
  const counts = await Promise.all(LEARNING_STORES.map((store) => idbCount(store)))
  return counts.some((count) => count > 0)
}

/**
 * 로컬 데이터베이스를 통째로 지운다.
 *
 * 계정 초기화·로그아웃 뒤 새 계정으로 옛 데이터가 새지 않게 한다. 열어 둔 연결이
 * 있으면 삭제가 blocked 로 끝나므로, 캐시된 연결을 먼저 닫고 기억도 버린다.
 * 한 번도 연 적이 없어도 안전하다 — 그때는 지울 것도, 닫을 것도 없다.
 *
 * **호출자 계약:** 이 함수가 reject 하면 초기화는 **확인되지 않은** 것이다.
 * 성공으로 보고하면 안 된다. 특히 blocked 는 다른 탭이 연결을 잡고 있다는 뜻으로,
 * 브라우저는 그 탭이 닫힌 뒤 삭제를 마저 진행할 수 있다. 즉 reject 후에도 데이터가
 * 나중에 지워질 수 있으므로, 호출자는 다른 탭을 닫고 다시 시도해야 한다.
 */
export async function deleteLocalDatabase(): Promise<void> {
  // 이 플래그를 세운 뒤에는 openDb() 를 부르지 않는다 — 자기 자신이 연 연결에
  // 막히면 영원히 기다리게 된다
  resetInProgress = true
  try {
    const pending = dbPromise
    // 닫는 동안 openDb() 가 닫힌 연결을 돌려주지 않도록 먼저 버린다
    dbPromise = null
    if (pending) {
      // 열다가 실패한 연결은 닫을 것이 없다
      const db = await pending.catch(() => null)
      db?.close()
    }

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => resolve()
      request.onerror = () =>
        reject(request.error ?? new Error('로컬 데이터베이스를 지우지 못했습니다'))
      /**
       * 다른 탭이 연결을 잡고 있으면 삭제가 시작되지 않는다.
       * 그대로 두면 영원히 기다리게 되므로 분명한 오류로 끝낸다.
       * 삭제 요청 자체는 남아 있으므로, 그 탭이 닫히면 나중에 완료될 수 있다.
       */
      request.onblocked = () =>
        reject(
          new Error(
            '다른 탭이 로컬 데이터를 쓰고 있어 지우지 못했습니다. 다른 탭을 닫고 다시 시도해 주세요.',
          ),
        )
    })
  } finally {
    // 실패해도 다음 요청이 연결을 열 수 있어야 한다
    resetInProgress = false
  }
}