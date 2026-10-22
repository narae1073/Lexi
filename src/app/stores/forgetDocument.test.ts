import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  SYNC_META_KEY,
  idbDeleteByIndex,
  idbGetAll,
  idbGetAllByIndex,
  idbPut,
  replaceOccurrences,
} from '../../lib/storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from './occurrences'
import { useOccurrencesStore } from './occurrences'

const doc: Document = {
  id: 'doc-1',
  title: 'Untitled',
  languageCode: 'ko',
  rawText: '어느 문서든 되살아나면 안 됩니다.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const occurrence = (lemma: string, documentId = doc.id): WordOccurrence => ({
  documentId,
  languageCode: 'ko',
  lemma,
  surfaces: [lemma],
  count: 1,
  charStart: 0,
  charEnd: lemma.length,
  sentence: lemma,
  documentTitle: doc.title,
  recordedAt: 1,
})

/**
 * 문서를 잊는 것.
 *
 * 회귀 두 가지:
 * 1. `documentMeta` 는 주키가 documentId 다 — 같은 이름의 **인덱스가 없다.** 인덱스로
 *    지우면 NotFoundError 가 나고 그 뒤 코드가 아예 실행되지 않아 기억 속 목록이
 *    갱신되지 않았다. 완전 삭제한 문서의 단어가 단어장에 그대로 남았다
 * 2. 지워지지 않은 기록은 동기화 뒤 되돌아온다 — 단어장에 남는 것으로 드러난다
 */
describe('문서를 잊는다', () => {
  beforeEach(async () => {
    useOccurrencesStore.setState({
      byLanguage: {},
      occurrences: [],
      recorded: {},
      refreshing: false,
    })
    await replaceOccurrences(doc.id, [occurrence('되살아나면'), occurrence('어느')])
    await idbPut(STORES.documentMeta, { documentId: doc.id, lemmaVersion: 2 })
  })

  it('저장소에서 그 문서의 기록이 지워진다', async () => {
    expect(await idbGetAllByIndex(STORES.wordOccurrences, 'languageCode', 'ko')).toHaveLength(2)

    await useOccurrencesStore.getState().forgetDocument(doc.id)

    expect(await idbGetAllByIndex(STORES.wordOccurrences, 'languageCode', 'ko')).toHaveLength(0)
  })

  /** 예전엔 여기서 예외가 났고, 그 뒤 코드가 실행되지 않았다 */
  it('계산 기록도 지워진다 — 예외가 나면 안 된다', async () => {
    await expect(useOccurrencesStore.getState().forgetDocument(doc.id)).resolves.toBeUndefined()
    // The reserved sync-meta record is device bookkeeping, not a document's
    // computation record — forgetting a document must erase only its own row
    const rows = await idbGetAll<{ documentId: string }>(STORES.documentMeta)
    expect(rows.filter((m) => m.documentId !== SYNC_META_KEY)).toHaveLength(0)
  })

  it('기억 속 목록에서도 빠진다 — 그래야 단어장에서 사라진다', async () => {
    useOccurrencesStore.setState({
      byLanguage: { ko: [occurrence('되살아나면'), occurrence('어느')] },
      occurrences: [occurrence('되살아나면'), occurrence('어느')],
      recorded: { [doc.id]: true },
    })

    await useOccurrencesStore.getState().forgetDocument(doc.id)

    const state = useOccurrencesStore.getState()
    expect(state.byLanguage.ko ?? []).toHaveLength(0)
    expect(state.occurrences).toHaveLength(0)
    expect(state.recorded[doc.id]).toBeUndefined()
  })

  it('다른 문서의 기록은 남는다', async () => {
    await replaceOccurrences('doc-2', [occurrence('다른', 'doc-2')])
    await useOccurrencesStore.getState().forgetDocument(doc.id)
    expect(await idbGetAllByIndex(STORES.wordOccurrences, 'languageCode', 'ko')).toHaveLength(1)
  })
})

/**
 * 인덱스로 지우기.
 *
 * 회귀: 이 함수는 `tx()` 로 돌았다. `tx()` 는 `run()` 이 돌려준 요청에 `onsuccess` 를
 * 다시 붙이는데, 여기서는 그 자리에 커서를 돌리는 동작을 걸어 놓았다. **덮어써져서
 * 실행되지 않았다.** 아무것도 지워지지 않고 조용히 성공한 것처럼 값만 돌려줬다.
 */
describe('인덱스로 지우기', () => {
  const record = (documentId: string, lemma: string) => ({
    documentId,
    languageCode: 'ko',
    lemma,
    surfaces: [lemma],
    count: 1,
    charStart: 0,
    charEnd: 1,
    sentence: '',
    documentTitle: '',
    recordedAt: 1,
  })

  beforeEach(async () => {
    await replaceOccurrences('doc-1', [record('doc-1', '하나'), record('doc-1', '둘')])
    await replaceOccurrences('doc-2', [record('doc-2', '셋')])
  })

  it('그 값을 가진 것을 지운다', async () => {
    await idbDeleteByIndex(STORES.wordOccurrences, 'documentId', 'doc-1')
    const left = await idbGetAllByIndex<{ lemma: string }>(STORES.wordOccurrences, 'languageCode', 'ko')
    expect(left.map((r) => r.lemma)).toEqual(['셋'])
  })

  it('해당하는 것이 없으면 조용히 끝난다', async () => {
    await expect(idbDeleteByIndex(STORES.wordOccurrences, 'documentId', 'nope')).resolves.toBeUndefined()
    expect(await idbGetAllByIndex(STORES.wordOccurrences, 'languageCode', 'ko')).toHaveLength(3)
  })

  it('실제로 지워졌는지 확인한다 — 조용히 성공한 것처럼 보이면 안 된다', async () => {
    await idbDeleteByIndex(STORES.wordOccurrences, 'documentId', 'doc-1')
    expect(await idbGetAll(STORES.wordOccurrences)).toHaveLength(1)
  })
})
