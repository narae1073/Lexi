import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbGetAllByIndex } from '../../lib/storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from './occurrences'
import { useOccurrencesStore } from './occurrences'
import { useWordStatesStore } from './wordStates'

/**
 * 서버의 길이 제약이 우리 토크나이저 산출물을 거부하면 안 된다.
 *
 * 서버는 lemma·surface 200자, 문장 5,000자까지만 받는다. 그런데 토크나이저는
 * 공백 없이 이어진 글자를 하나의 단어로 본다 — 붙여넣은 URL·해시·긴 문장이
 * 그대로 제약을 넘길 수 있다. 거부된 행은 동기화를 막고, 그 뒤의 정상 기록까지
 * 서버로 가지 못하게 만든다. 그래서 기록을 만들 때 우리 쪽에서 먼저 줄인다.
 */
const LEMMA_LIMIT = 200
const SENTENCE_LIMIT = 5_000

const longToken = 'x'.repeat(300)
/** 6,000자 — 한 문장이 서버의 문장 상한을 넘는 경우 */
const longSentence = 'word '.repeat(1_200)

const doc: Document = {
  id: 'doc-long-input',
  title: 'Long input',
  languageCode: 'en',
  rawText: `ok ${longToken} ${longSentence}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('등장 기록은 서버 길이 제약 안에서 만든다', () => {
  beforeEach(() => {
    useOccurrencesStore.setState({
      byLanguage: {},
      occurrences: [],
      recorded: {},
      refreshing: false,
    })
  })

  it('300자 토큰은 건너뛰고 6,000자 문장은 5,000자로 줄여 저장한다', async () => {
    await useOccurrencesStore.getState().recordDocument(doc)

    const rows = await idbGetAllByIndex<WordOccurrence>(
      STORES.wordOccurrences,
      'documentId',
      doc.id,
    )

    // 긴 토큰 하나 때문에 문서의 나머지 기록까지 버리면 안 된다
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => row.lemma === longToken)).toBe(false)
    expect(rows.every((row) => row.lemma.length <= LEMMA_LIMIT)).toBe(true)
    expect(rows.every((row) => row.surfaces.every((s) => s.length <= LEMMA_LIMIT))).toBe(true)
    expect(rows.every((row) => row.sentence.length <= SENTENCE_LIMIT)).toBe(true)
    expect(rows.find((row) => row.lemma === 'ok')?.sentence).toHaveLength(SENTENCE_LIMIT)
  })
})

/**
 * lemma 가 200자를 넘는 단어 상태는 서버가 거부한다. 화면에서 먼저 막지 않으면
 * 그 변경이 동기화 큐에 걸려 뒤의 정상 변경까지 막는다.
 */
describe('단어 상태는 200자를 넘는 lemma 를 받지 않는다', () => {
  const longLemma = 'y'.repeat(300)

  beforeEach(() => {
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
  })

  it('상태·즐겨찾기·별·메모·지우기 모두 조용히 건너뛴다', () => {
    const store = useWordStatesStore.getState()
    store.setStatus('en', longLemma, 'known', longLemma)
    store.pressStatus('en', longLemma, 'known', 'known', longLemma)
    store.toggleFavorite('en', longLemma, longLemma)
    store.setStarColor('en', longLemma, '#ffffff', longLemma)
    store.setNote('en', longLemma, 'note', longLemma)
    store.clearStatus('en', longLemma)

    expect(useWordStatesStore.getState().byKey[`en::${longLemma}`]).toBeUndefined()
  })
})
