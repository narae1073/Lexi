import { STAR_COLOR_DEFAULT } from '../../app/stores/settings'
import type { Document, Folder, WordStatus } from '../../types'
import type { DocumentTombstone } from '../storage/purged'

/**
 * 로컬 ↔ 서버 병합 규칙 (PLAN.md Phase 6).
 *
 * 기기가 두 대면 같은 단어를 서로 다르게 표시한 상태가 생긴다.
 * 한쪽을 무조건 이기는 대신:
 *   - `last_seen_at` 이 더 최근인 쪽의 상태를 쓴다 (마지막 조작이 정답이다)
 *   - 시간이 같으면 사용자가 직접 고른 상태를 쓴다
 *   - `seen_count` 는 큰 값, `first_seen_at` 은 이른 값 — 두 기기에서 봤으면
 *     두 번이 맞으므로 합이 자연스럽지만, 같은 값을 여러 번 합치면 매번 늘어나
 *     동기화가 돌 때마다 숫자가 불어납니다. 따라서 큰 값이다.
 *
 * 아래 `mergeWordStates` 는 같은 입력으로 여러 번 돌려도 결과가 같아야 한다
 * (idempotent). 그게 깨지면 동기화가 조용히 상태를 망가뜨린다.
 */

export type WordStateRecord = {
  languageCode: string
  lemma: string
  /** 사용자가 고른 상태. 아직 고르지 않았으면 undefined */
  status?: WordStatus
  seenCount: number
  firstSeenAt: string
  lastSeenAt: string
  /** 즐겨찾기. 상태와 독립이라 별도 시각으로 병합한다 */
  favorite: boolean
  /** 별을 마지막으로 붙이거나 떼거나 색을 바꾼 시각 — 늦은 쪽의 별이 이긴다 */
  favoriteUpdatedAt: string
  /** 별 스티커의 기울기(도)와 색 — 별의 시각을 이긴 쪽의 것을 함께 쓴다 */
  starAngle: number
  starColor: string
  /** 퀴즈에서 상태 단추를 누른 횟수 — seen_count 처럼 큰 값으로 합친다 */
  knownPresses: number
  unsurePresses: number
  unknownPresses: number
  /** 사용자가 적은 메모 — 없으면 비어 있다 */
  note?: string
  /**
   * 메모를 마지막으로 고친 시각. 없으면 고친 적이 없다.
   *
   * lastSeenAt 으로 대신하지 않는다 — 상태만 바꾼 기기가 다른 기기의 메모를
   * 지워 버리기 때문이다.
   */
  noteUpdatedAt?: string
}

/**
 * A word-state row as it may sit in IndexedDB.
 *
 * Rows written before the star, quiz-press, or note fields existed lack them,
 * so every one of those fields is optional here. `normalizeWordState` fills the
 * holes without inventing history the user never made.
 */
export type StoredWordState = Omit<
  WordStateRecord,
  | 'favorite'
  | 'favoriteUpdatedAt'
  | 'starAngle'
  | 'starColor'
  | 'knownPresses'
  | 'unsurePresses'
  | 'unknownPresses'
> & {
  /** Legacy field from an older row shape; not part of the merge. */
  surface?: string
  favorite?: boolean
  favoriteUpdatedAt?: string
  starAngle?: number
  starColor?: string
  knownPresses?: number
  unsurePresses?: number
  unknownPresses?: number
}

/**
 * Fills the fields old rows may not have.
 *
 * Missing is not the same as a value: a row from before the star feature has
 * no star, and a row from before notes has no note. Absence becomes the field's
 * neutral value, never a claim that the user did something.
 */
export function normalizeWordState(row: StoredWordState): WordStateRecord {
  return {
    languageCode: row.languageCode,
    lemma: row.lemma,
    status: row.status,
    seenCount: row.seenCount,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    favorite: row.favorite ?? false,
    favoriteUpdatedAt: row.favoriteUpdatedAt ?? row.lastSeenAt,
    starAngle: row.starAngle ?? 0,
    starColor: row.starColor ?? STAR_COLOR_DEFAULT,
    knownPresses: row.knownPresses ?? 0,
    unsurePresses: row.unsurePresses ?? 0,
    unknownPresses: row.unknownPresses ?? 0,
    // null/undefined means "never edited" — a status-only device must not erase a note
    note: row.note,
    noteUpdatedAt: row.noteUpdatedAt,
  }
}

export type MergeOutcome<T> = {
  /** 병합 결과 — 이걸 로컬과 서버 양쪽에 반영한다 */
  merged: T[]
  /** 서버에 없던 로컬 항목 — push 대상 */
  pushOnly: T[]
  /** 로컬에 없던 서버 항목 — pull 후 로컬에 새로 들어감 */
  pullOnly: T[]
}

const keyOf = (r: WordStateRecord) => `${r.languageCode}::${r.lemma}`

/**
 * 상태가 없는 항목에 기본값을 준다.
 *
 * 서버의 word_states.status 는 NOT NULL 이라 없는 채로 보낼 수 없다.
 * 로컬도 상태 없이 단어를 만들지 않지만, 서버에만 있던 항목까지 합친
 * 병합 결과에는 빈칸이 남아 있을 수 있어 한 곳에 모아 둔다.
 */
export function withStatus(
  record: WordStateRecord,
  fallback: WordStatus = 'unsure',
): WordStateRecord & { status: WordStatus } {
  return { ...record, status: record.status ?? fallback }
}

/**
 * 이쪽이 더 늦은가.
 *
 * **문자열로 비교하지 않는다.** 이 기기는 `2026-10-04T21:00:00.000Z` 를 쓰고,
 * 서버(Postgres timestamptz)는 `2026-10-04T21:00:00+00:00` 를 준다 — 같은 시각인데
 * 문자열은 다르다. 같은 자리에서 `+`(0x2B) 와 `.`(0x2E) 가 갈라지므로 **문자열 비교는
 * 형식에 따라 어느 쪽이 이기는지가 뒤집힌다.** 형식이 바뀌면 사용자가 직접 고른 상태가
 * 조용히 사라진다 — 서버가 더 늦다고 잘못 판단되면 그 기기의 변경이推送되지 않는다.
 *
 * 시각으로 비교한다. 해석할 수 없으면 **'더 늦지 않다' 고 본다.** 모르는 것을 알고 있다고
 * 말하지 않기 때문이다. 또 이쪽이 지는 쪽이므로, 해석 실패는 서버에 밀어 넣는 쪽으로
 * 흐른다 — 기기 안에만 남는 쪽이 아니다.
 */
export function isNewer(a: string, b: string): boolean {
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (Number.isNaN(left) || Number.isNaN(right)) return false
  return left > right
}

/** ISO 형식이 섞여도 되는 비교를 문서 쪽에도 쓴다 */
export function newerThan(a: string, b: string): boolean {
  return isNewer(a, b)
}

/**
 * 상태를 비운 행이라도 즐겨찾기·메모·퀴즈 횟수가 있으면 서버에 남겨야 한다.
 *
 * 그 기록이 같은 행에 있으므로, 비었다고 보내지 않으면 다른 기기에서 사라진다.
 * 아무 기록도 없는 빈 행만 조용히 둔다.
 */
function hasHistory(record: WordStateRecord): boolean {
  return (
    record.favorite ||
    record.note !== undefined ||
    record.knownPresses > 0 ||
    record.unsurePresses > 0 ||
    record.unknownPresses > 0
  )
}

export function mergeWordStates(
  local: WordStateRecord[],
  remote: WordStateRecord[],
): MergeOutcome<WordStateRecord> {
  const remoteByKey = new Map(remote.map((r) => [keyOf(r), r]))
  const localByKey = new Map(local.map((r) => [keyOf(r), r]))

  const merged: WordStateRecord[] = []
  const pushOnly: WordStateRecord[] = []
  const pullOnly: WordStateRecord[] = []

  for (const [key, mine] of localByKey) {
    const theirs = remoteByKey.get(key)

    if (!theirs) {
      // 여기만 남았다. 상태도 없고 즐겨찾기·메모·횟수도 없으면 보낼 것이 없다.
      // 기록이 하나라도 있으면 status = null 인 행으로 보낸다 — 행을 지우면
      // 그 기록이 서버에서 사라진다.
      if (mine.status === undefined && !hasHistory(mine)) {
        merged.push(mine)
        continue
      }
      pushOnly.push(mine)
      merged.push(mine)
      continue
    }

    const winner = pickWinner(mine, theirs)

    // 병합 결과가 그대로 서버와 같으면 또 보내지 않는다 — 불필요한 쓰기를 막고
    // 무한 갱신을 피한다
    if (sameAsServer(winner, theirs)) merged.push(winner)
    else {
      merged.push(winner)
      pushOnly.push(winner)
    }
  }

  for (const [key, theirs] of remoteByKey) {
    if (!localByKey.has(key)) {
      pullOnly.push(theirs)
      merged.push(theirs)
    }
  }

  return { merged, pushOnly, pullOnly }
}

function pickWinner(mine: WordStateRecord, theirs: WordStateRecord): WordStateRecord {
  const mineNewer = isNewer(mine.lastSeenAt, theirs.lastSeenAt)
  const theirsNewer = isNewer(theirs.lastSeenAt, mine.lastSeenAt)

  let statusSource: WordStateRecord
  if (mineNewer && !theirsNewer) statusSource = mine
  else if (theirsNewer && !mineNewer) statusSource = theirs
  // 시간이 같거나 둘 다 새롭지 않으면 사용자가 직접 고른 상태를 우선한다
  else statusSource = theirs.status ? theirs : mine.status ? mine : mine

  return {
    languageCode: mine.languageCode,
    lemma: mine.lemma,
    status: statusSource.status,
    seenCount: Math.max(mine.seenCount, theirs.seenCount),
    // 누른 횟수도 큰 값 — seen_count 와 같은 규칙이다 (기기별 증분을 더하지는 않는다)
    knownPresses: Math.max(mine.knownPresses, theirs.knownPresses),
    unsurePresses: Math.max(mine.unsurePresses, theirs.unsurePresses),
    unknownPresses: Math.max(mine.unknownPresses, theirs.unknownPresses),
    firstSeenAt: isNewer(mine.firstSeenAt, theirs.firstSeenAt) ? theirs.firstSeenAt : mine.firstSeenAt,
    lastSeenAt: isNewer(mine.lastSeenAt, theirs.lastSeenAt) ? mine.lastSeenAt : theirs.lastSeenAt,
    ...pickFavorite(mine, theirs),
    ...pickNote(mine, theirs),
  }
}

/**
 * 별은 상태와 따로 병합한다.
 *
 * 행 전체를 '늦은 쪽이 이긴다' 로 하면 이런 일이 생긴다: A 기기에서 별을 뗐는데
 * B 기기에서 상태를 바꾸면 B 행이 더 늦어 별이 되살아난다. 사용자가 직접
 * 뗀 별이 돌아오면 앱이 말을 안 듣는 것처럼 보인다.
 *
 * 그래서 별은 별의 시각으로만 겨룬다. 동률이면 합집합(OR) — 둘 다 모르는 사이에
 * 붙인 별을 잃는 쪽보다, 해제 한 번 더 누르는 쪽이 싸다.
 */
function pickFavorite(
  mine: WordStateRecord,
  theirs: WordStateRecord,
): Pick<WordStateRecord, 'favorite' | 'favoriteUpdatedAt' | 'starAngle' | 'starColor'> {
  if (isNewer(mine.favoriteUpdatedAt, theirs.favoriteUpdatedAt)) {
    return {
      favorite: mine.favorite,
      favoriteUpdatedAt: mine.favoriteUpdatedAt,
      starAngle: mine.starAngle,
      starColor: mine.starColor,
    }
  }
  if (isNewer(theirs.favoriteUpdatedAt, mine.favoriteUpdatedAt)) {
    return {
      favorite: theirs.favorite,
      favoriteUpdatedAt: theirs.favoriteUpdatedAt,
      starAngle: theirs.starAngle,
      starColor: theirs.starColor,
    }
  }
  return {
    favorite: mine.favorite || theirs.favorite,
    favoriteUpdatedAt: isNewer(mine.favoriteUpdatedAt, theirs.favoriteUpdatedAt)
      ? mine.favoriteUpdatedAt
      : theirs.favoriteUpdatedAt,
    // 동률이면 어느 쪽의 꾸밈이든 같다 — 같은 별을 두고 다투는 것이 아니다
    starAngle: mine.starAngle,
    starColor: mine.starColor,
  }
}

/**
 * 메모는 메모의 시각으로만 겨룬다 — 별과 같은 이유다. '고친 적 없음' 과
 * '비웠음' 을 구분해야 상태만 바꾼 기기가 다른 기기의 메모를 지우지 않는다.
 */
function pickNote(
  mine: WordStateRecord,
  theirs: WordStateRecord,
): Pick<WordStateRecord, 'note' | 'noteUpdatedAt'> {
  const mineEdited = mine.noteUpdatedAt !== undefined
  const theirsEdited = theirs.noteUpdatedAt !== undefined

  // 둘 다 고친 적이 없으면 있는 쪽을 쓴다 (옛 행·기능 이전 행)
  if (!mineEdited && !theirsEdited) return { note: mine.note ?? theirs.note }
  if (mineEdited && !theirsEdited) return { note: mine.note, noteUpdatedAt: mine.noteUpdatedAt }
  if (theirsEdited && !mineEdited) return { note: theirs.note, noteUpdatedAt: theirs.noteUpdatedAt }

  // 둘 다 고친 적이 있으면 늦은 쪽이 이긴다. 동률이면 내용이 있는 쪽을 남긴다
  if (isNewer(mine.noteUpdatedAt ?? '', theirs.noteUpdatedAt ?? '')) {
    return { note: mine.note, noteUpdatedAt: mine.noteUpdatedAt }
  }
  if (isNewer(theirs.noteUpdatedAt ?? '', mine.noteUpdatedAt ?? '')) {
    return { note: theirs.note, noteUpdatedAt: theirs.noteUpdatedAt }
  }
  return {
    note: mine.note ?? theirs.note,
    noteUpdatedAt: mine.noteUpdatedAt ?? theirs.noteUpdatedAt,
  }
}

/** 서버 행과 비교할 때 — id/user_id 같은 서버 관리 값은 보지 않는다 */
function sameAsServer(a: WordStateRecord, b: WordStateRecord): boolean {
  return (
    a.status === b.status &&
    a.seenCount === b.seenCount &&
    a.firstSeenAt === b.firstSeenAt &&
    a.lastSeenAt === b.lastSeenAt &&
    a.favorite === b.favorite &&
    a.favoriteUpdatedAt === b.favoriteUpdatedAt &&
    a.starAngle === b.starAngle &&
    a.starColor === b.starColor &&
    a.knownPresses === b.knownPresses &&
    a.unsurePresses === b.unsurePresses &&
    a.unknownPresses === b.unknownPresses &&
    a.note === b.note &&
    a.noteUpdatedAt === b.noteUpdatedAt
  )
}

/**
 * 배울 언어 — 합집합.
 *
 * 서버에서 지우지 않는다. 다른 기기에서 추가한 언어를 이 기기에서 지웠다고 해서
 * 그 기기까지 지워져서는 안 된다. 문서도 그 언어에 남아 있을 수 있다.
 */
export function mergeLanguages(local: string[], remote: string[]): string[] {
  return [...new Set([...local, ...remote])]
}

/**
 * 문서 묘비 합치기 — 삭제는 되돌릴 수 없으므로 한 번이라도 지웠으면 남긴다.
 * 같은 문서를 두 기기에서 지웠다면 이른 시각을 쓴다.
 */
export function mergeTombstones(
  local: DocumentTombstone[],
  remote: DocumentTombstone[],
): DocumentTombstone[] {
  const byId = new Map<string, DocumentTombstone>()
  for (const tombstone of [...local, ...remote]) {
    const existing = byId.get(tombstone.documentId)
    if (!existing) {
      byId.set(tombstone.documentId, tombstone)
      continue
    }
    if (Date.parse(tombstone.purgedAt) < Date.parse(existing.purgedAt)) {
      byId.set(tombstone.documentId, tombstone)
    }
  }
  return [...byId.values()]
}

/** 문서는 id 로 갈아끼운다 — 마지막으로 고친 쪽이 이긴다 */
export function mergeDocuments(local: Document[], remote: Document[]): Document[] {
  const byId = new Map(remote.map((d) => [d.id, d]))
  for (const doc of local) {
    const theirs = byId.get(doc.id)
    if (!theirs) {
      byId.set(doc.id, doc)
      continue
    }
    /**
     * 문서 내용은 '마지막으로 고친(열은)' 쪽이 이긴다. 폴더는 그보다
     * **언제 옮겼는가**로 따로 이긴다 — 오래 전에 열Pi는 문서를 방금 옮긴
     * 기록이 열기의 무게로 잡혀 먹히면 안 되므로 두 인장을 따로 본다.
     */
    const winner = isNewer(doc.updatedAt, theirs.updatedAt) ? doc : theirs
    const folderWinner = folderWinnerOf(doc, theirs)
    if (winner === folderWinner) byId.set(doc.id, winner)
    else byId.set(doc.id, { ...winner, folderId: folderWinner.folderId ?? null, folderUpdatedAt: folderWinner.folderUpdatedAt })
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * 두 기록 가운데 폴더를 늦게 옮긴 쪽.
 *
 * 인장도 없는 옛 기록(폴더 기능 이전의 행)은 '없음' 이다 — 둘 다 인장이 없으면
 * 아무런 폴더 기록이 없는 것이고, 폴더에 없는 결과가 남는다. 한쪽에만 있으면
 * 그쪽이 이긴다.
 */
function folderWinnerOf(a: Document, b: Document): Document {
  const aStamp = a.folderUpdatedAt
  const bStamp = b.folderUpdatedAt
  // 둘 다 인장이 없으면 폴더 기록 자체가 없는 것이다 — 폴더에 없다고 남는다
  if (!aStamp && !bStamp) return { ...a, folderId: null, folderUpdatedAt: undefined }
  if (!bStamp) return a
  if (!aStamp) return b
  return isNewer(aStamp, bStamp) ? a : b
}

/**
 * 폴더는 id 로 갈아끼운다 — 문서와 같은 규칙이다.
 *
 * 톰스톤도 같은 자리로 온다. 지운 폴더의 updated_at 이 늦으면 그 지움이 이기고,
 * 옛 폴더가 되살아나지 않는다 (문서 휴지통 상태가 같은 방식으로 병합된다).
 *
 * 폴더에는 서버 트리거가 없다 — updated_at 을 우리가 찍어서 보내므로, 이
 * 병합은 클라이언트 인장을 그대로 믿는다.
 */
export function mergeFolders(local: Folder[], remote: Folder[]): Folder[] {
  const byId = new Map(remote.map((f) => [f.id, f]))
  for (const folder of local) {
    const theirs = byId.get(folder.id)
    if (!theirs) {
      byId.set(folder.id, folder)
      continue
    }
    if (!isNewer(folder.updatedAt, theirs.updatedAt)) {
      // 인장이 같은데 내용이 다르면 (지움 vs 고침) 지움을 믿는다 —
      // 되살려 놓는 실수보다 지운 채로 남는 쪽이 조용하다
      const tieGoesToTombstone = Boolean(folder.deletedAt && !theirs.deletedAt)
      byId.set(folder.id, tieGoesToTombstone ? folder : theirs)
      continue
    }
    byId.set(folder.id, folder)
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
