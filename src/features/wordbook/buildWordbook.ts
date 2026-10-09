import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordState, WordStatus } from '../../types'

/** plan.txt 9줄의 세 상태에, 아직 표시하지 않은 단어를 한 그룹으로 더한다.
 *  표시 기록이 없으면 어휘 목록의 대부분이 어디에도 속하지 않게 되어서 필요하다. */
export type WordbookGroup = WordStatus | 'unmarked' | 'favorite'

export const WORDBOOK_GROUPS: WordbookGroup[] = ['favorite', 'known', 'unsure', 'unknown', 'unmarked']

/** 깨진 저장은 ★ 탭으로 — 처음 여는 자리와 같다 */
export function wordbookGroupOrDefault(value: unknown): WordbookGroup {
  return WORDBOOK_GROUPS.includes(value as WordbookGroup) ? (value as WordbookGroup) : 'favorite'
}

export type WordbookEntry = {
  lemma: string
  /** 이 lemma 이 문서들에서 실제로 쓰인 표기들 */
  surfaces: string[]
  status: WordStatus | 'unmarked'
  /** 즐겨찾기 — 상태와 독립이라 어느 상태 탭에도 함께 있을 수 있다 */
  favorite: boolean
  /** 학습할 때 도움이 되는 문맥 예문 (가장 최근 문서의 것) */
  sentence: string
  documentId: string
  documentTitle: string
  /** 전체 출현 횟수 */
  count: number
  /** 몇 개의 문서에 등장했는지 */
  documentCount: number
}

type StatusLookup = (languageCode: string, lemma: string) => WordState | undefined

export type BuildOptions = {
  languageCode: string
  occurrences: WordOccurrence[]
  /** word_states 를 직접 받거나, 조회 함수를 넘긴다 */
  byKey?: Record<string, WordState>
  statusOf?: StatusLookup
  /** 문서 안에서 들어온 경우 — 그 문서의 단어만 보여준다 (plan.txt 9줄) */
  documentId?: string
  /** 표기로 검색 */
  query?: string
}

/**
 * 등장 기록과 상태를 합쳐 단어장 목록을 만든다.
 *
 * 등장 기록(occurrences)이 "어떤 단어가 나왔는가", 상태가 "내가 어떻게 표시했는가" 를
 * 따로 들고 있으므로 둘을 합쳐야 목록이 된다.
 */
export function buildWordbook({
  languageCode,
  occurrences,
  byKey,
  statusOf,
  documentId,
  query,
}: BuildOptions): WordbookEntry[] {
  const lookup: StatusLookup =
    statusOf ?? ((lang, lemma) => byKey?.[`${lang}::${lemma}`])

  const scoped = documentId
    ? occurrences.filter((o) => o.documentId === documentId)
    : occurrences

  // 같은 lemma 는 문서별로 한 행씩 있다
  const merged = new Map<string, WordbookEntry>()
  /** lemma 별 가장 최근 기록 시각 — 예문 선택에 쓴다 */
  const mergedMeta = new Map<string, number>()

  for (const occurrence of scoped) {
    const existing = merged.get(occurrence.lemma)
    const status = lookup(languageCode, occurrence.lemma)?.status ?? 'unmarked'
    let newestRecordedAt = existing ? (mergedMeta.get(occurrence.lemma) ?? 0) : 0

    if (!existing) {
      merged.set(occurrence.lemma, {
        lemma: occurrence.lemma,
        surfaces: [...occurrence.surfaces],
        status,
        favorite: lookup(languageCode, occurrence.lemma)?.favorite ?? false,
        sentence: occurrence.sentence,
        documentId: occurrence.documentId,
        documentTitle: occurrence.documentTitle,
        count: occurrence.count,
        documentCount: 1,
      })
      mergedMeta.set(occurrence.lemma, occurrence.recordedAt)
      continue
    }

    existing.count += occurrence.count
    existing.documentCount += 1
    for (const surface of occurrence.surfaces) {
      if (!existing.surfaces.includes(surface)) existing.surfaces.push(surface)
    }
    // 예문은 가장 최근에 기록된 문서의 것으로 보여준다
    if (occurrence.recordedAt >= newestRecordedAt) {
      newestRecordedAt = occurrence.recordedAt
      mergedMeta.set(occurrence.lemma, occurrence.recordedAt)
      existing.sentence = occurrence.sentence
      existing.documentId = occurrence.documentId
      existing.documentTitle = occurrence.documentTitle
    }
  }

  const entries = [...merged.values()]

  // 상태가 나중에 바뀌었을 수 있으므로 병합 후 다시 확인한다
  for (const entry of entries) {
    entry.status = lookup(languageCode, entry.lemma)?.status ?? 'unmarked'
    entry.favorite = lookup(languageCode, entry.lemma)?.favorite ?? false
  }

  const needle = query?.trim().toLowerCase()
  const filtered = needle
    ? entries.filter(
        (entry) =>
          entry.lemma.toLowerCase().includes(needle) ||
          entry.surfaces.some((s) => s.toLowerCase().includes(needle)),
      )
    : entries

  return filtered.sort((a, b) =>
    // 표기가 다르면(US / us) 표기를 보여준다
    a.lemma.localeCompare(b.lemma, languageCode, { sensitivity: 'base' }),
  )
}

export function groupByStatus(
  entries: WordbookEntry[],
): Record<WordbookGroup, WordbookEntry[]> {
  const grouped: Record<WordbookGroup, WordbookEntry[]> = {
    unmarked: [],
    known: [],
    unsure: [],
    unknown: [],
    favorite: [],
  }
  for (const entry of entries) {
    grouped[entry.status].push(entry)
    // 별은 상태와 독립 — 상태 탭에 있으면서 ★ 탭에도 있다
    if (entry.favorite) grouped.favorite.push(entry)
  }
  return grouped
}