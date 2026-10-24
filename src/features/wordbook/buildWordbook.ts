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

/**
 * Language switches must not land on an empty tab. The ★ tab is the intentional
 * default for a fresh wordbook, but a language with no favorites would show an
 * empty screen — and, for ja/zh, never render an example that can trigger the
 * dictionary prompt. Keep the current tab when it has rows; otherwise use the
 * first non-empty tab in display order.
 */
export function firstNonEmptyGroup(
  grouped: Record<WordbookGroup, WordbookEntry[]>,
  current: WordbookGroup,
): WordbookGroup {
  if (grouped[current].length > 0) return current
  return WORDBOOK_GROUPS.find((key) => grouped[key].length > 0) ?? current
}

export type WordbookEntry = {
  lemma: string
  /** 이 lemma 이 문서들에서 실제로 쓰인 표기들 */
  surfaces: string[]
  status: WordStatus | 'unmarked'
  /** 즐겨찾기 — 상태와 독립이라 어느 상태 탭에도 함께 있을 수 있다 */
  favorite: boolean
  /** 별 스티커의 색 — ★ 탭에서 색으로 좁히는 데 쓴다 */
  starColor?: string
  /** 학습할 때 도움이 되는 문맥 예문 (가장 최근 문서의 것) */
  sentence: string
  documentId: string
  documentTitle: string
  /**
   * 이 단어가 나온 문장 전부 — 퀴즈가 세션마다 다른 문맥을 골라 쓴다.
   * 같은 문장이 여러 문서에 있어도 한 번만 담는다.
   */
  contexts: { sentence: string; documentTitle: string }[]
  /** 마지막으로 본 시각 — 간격 복습이 기한을 계산한다 */
  lastSeenAt: string
  /** 앎 단추를 누른 횟수 — 앎 단어의 복습 간격을 늘린다 */
  knownPresses: number
  /** 사용자가 적은 메모 — 단어장과 퀴즈에서 다시 본다 */
  note?: string
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
    const state = lookup(languageCode, occurrence.lemma)
    const status = state?.status ?? 'unmarked'
    const context = {
      sentence: occurrence.sentence,
      documentTitle: occurrence.documentTitle,
    }
    let newestRecordedAt = existing ? (mergedMeta.get(occurrence.lemma) ?? 0) : 0

    if (!existing) {
      merged.set(occurrence.lemma, {
        lemma: occurrence.lemma,
        surfaces: [...occurrence.surfaces],
        status,
        favorite: state?.favorite ?? false,
        starColor: state?.starColor,
        sentence: occurrence.sentence,
        documentId: occurrence.documentId,
        documentTitle: occurrence.documentTitle,
        contexts: occurrence.sentence ? [context] : [],
        lastSeenAt: state?.lastSeenAt ?? '',
        knownPresses: state?.knownPresses ?? 0,
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
    // 문맥은 전부 모은다 — 퀴즈가 세션마다 다른 문장을 골라 쓴다
    if (
      occurrence.sentence &&
      !existing.contexts.some((item) => item.sentence === occurrence.sentence)
    ) {
      existing.contexts.push(context)
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
    const state = lookup(languageCode, entry.lemma)
    entry.status = state?.status ?? 'unmarked'
    entry.favorite = state?.favorite ?? false
    entry.starColor = state?.starColor
    entry.lastSeenAt = state?.lastSeenAt ?? ''
    entry.knownPresses = state?.knownPresses ?? 0
    entry.note = state?.note
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

/**
 * ★ 탭을 별 색으로 좁힌다 — 여러 색을 겹쳐 켤 수 있다 (개선사항.txt: 단어장의
 * Favorites 탭에서 별 색깔 고르기).
 *
 * 아무 색도 켜지 않았으면(빈 배열) 걸러는 일이 없다 — 전부 보여 준다.
 * 켠 색 안에 별 색이 들면 남는다. 별 색이 없는 행(별 기능 이전의 기록)은
 * 켠 색과 같을 수 없으므로 걸러 진다 — 색이 없는데 어느 색에도 속한다고
 * 보여 주는 것은 '빈 화면' 과 같은 거짓말보다 낫다.
 */
export function filterByStarColors(
  entries: WordbookEntry[],
  colors: readonly string[],
): WordbookEntry[] {
  if (colors.length === 0) return entries
  const active = new Set(colors.map((c) => c.toLowerCase()))
  return entries.filter((entry) =>
    entry.starColor !== undefined && active.has(entry.starColor.toLowerCase()),
  )
}