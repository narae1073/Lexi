import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { putDocumentContent, readDocumentContent } from '../../lib/storage/documentContent'
import { STORES, deleteLocalDatabase, idbPut } from '../../lib/storage/localDb'
import type { Document } from '../../types'
import { useAuthStore } from './auth'
import { useDocumentsStore } from './documents'

class MemoryStorage {
  #map = new Map<string, string>()

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null
  }

  setItem(key: string, value: string) {
    this.#map.set(key, String(value))
  }

  removeItem(key: string) {
    this.#map.delete(key)
  }

  clear() {
    this.#map.clear()
  }

  key(index: number) {
    return [...this.#map.keys()][index] ?? null
  }

  get length() {
    return this.#map.size
  }
}

beforeAll(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage
})

beforeEach(async () => {
  await deleteLocalDatabase()
  ;(globalThis as { localStorage?: Storage }).localStorage?.clear()
  useAuthStore.setState({ user: null })
  useDocumentsStore.setState({ documents: [] })
})

const doc: Document = {
  id: 'doc-1',
  title: 'Purged',
  languageCode: 'fr',
  rawText: 'Le chat dort.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('local document purge', () => {
  it('removes the cached body with the document', async () => {
    await putDocumentContent(doc.id, {
      rawText: doc.rawText,
      contentUpdatedAt: '2026-01-02T00:00:00.000Z',
      occurrencesUpdatedAt: '2026-01-02T00:00:00.000Z',
    })
    await idbPut(STORES.documents, doc, { silent: true })
    useDocumentsStore.setState({ documents: [doc] })

    await useDocumentsStore.getState().purge(doc.id)

    expect(await readDocumentContent(doc.id)).toBeUndefined()
  })
})
