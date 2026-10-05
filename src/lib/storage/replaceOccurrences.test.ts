import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbGetAllByIndex, replaceOccurrences } from '../../lib/storage/localDb'
import type { WordOccurrence } from '../../app/stores/occurrences'

const record = (lemma: string, extra: Partial<WordOccurrence> = {}): WordOccurrence => ({
  documentId: extra.documentId ?? 'doc-1',
  languageCode: 'fr',
  lemma,
  surfaces: [lemma],
  count: 1,
  charStart: 0,
  charEnd: lemma.length,
  sentence: '',
  documentTitle: '',
  recordedAt: 1,
  ...extra,
})

const lemmasInStore = async () => {
  const rows = await idbGetAllByIndex<WordOccurrence>(STORES.wordOccurrences, 'languageCode', 'fr')
  return rows.map((r) => r.lemma).sort()
}

/**
 * 문서를 다시 계산할 때 옛 기록이 남지 않아야 한다.
 *
 * 회귀: `replaceOccurrences` 는 커서로 지우면서 새 것을 넣는다. 옛 표기규칙이 만든
 * lemma 키는 새 규칙에서 나오지 않으므로, **같은 키로 덮어써지지 않고 그대로 남는다.**
 * 그러면 목록은 옛 키를 '옳지 않은 단어' 로 함께 세어 진도가 낮게 나온다 — 본문의
 * 상태 바와 어긋난다.
 *
 *   저장 전:  ["été", "l'été"]
 *   저장 후:  ["chat", "été", "l'été"] ← 옛 키가 살아남는다
 */
describe('문서의 등장 기록을 통째로 교체한다', () => {
  beforeEach(async () => {
    await replaceOccurrences('doc-1', [])
  })

  it('처음 넣은 것은 그대로 들어간다', async () => {
    await replaceOccurrences('doc-1', [record('été'), record('chat')])
    expect(await lemmasInStore()).toEqual(['chat', 'été'])
  })

  it('다시 넣으면 지난 것이 남지 않는다', async () => {
    await replaceOccurrences('doc-1', [record('été'), record('chat')])
    await replaceOccurrences('doc-1', [record('été')])
    expect(await lemmasInStore()).toEqual(['été'])
  })

  /**
   * 표기 규칙이 바뀌는 경우 — 여기가 실제 문제다.
   *
   * 옛 규칙이 만든 키(`l'été`)는 새 규칙에서 나오지 않는다. 같은 키로 덮어써지지 않으니
   * 살아남고, 목록은 그것을 별개의 단어로 세어 진도가 어긋난다.
   */
  it('새 규칙에서 나오지 않는 옛 키는 사라져야 한다', async () => {
    await replaceOccurrences('doc-1', [record("l'été"), record('chat')])

    // 축약 규칙이 바뀌어 'été' 로 다시 계산되었다
    await replaceOccurrences('doc-1', [record('été'), record('chat')])

    const left = await lemmasInStore()
    expect(left).toEqual(['chat', 'été'])
    expect(left).not.toContain("l'été")
  })

  it('빈 목록으로 교체하면 그 문서의 기록이 모두 사라진다', async () => {
    await replaceOccurrences('doc-1', [record('été'), record('chat')])
    await replaceOccurrences('doc-1', [])
    expect(await lemmasInStore()).toEqual([])
  })

  it('다른 문서의 기록은 건드리지 않는다', async () => {
    await replaceOccurrences('doc-2', [record('autre', { documentId: 'doc-2' })])
    await replaceOccurrences('doc-1', [record('été')])
    await replaceOccurrences('doc-1', [])
    const rows = await idbGetAllByIndex<WordOccurrence>(STORES.wordOccurrences, 'languageCode', 'fr')
    expect(rows.map((r) => r.lemma)).toEqual(['autre'])
  })
})