import type { WordStatus } from '../../types'

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

/** ISO 문자열 비교 — 문자열이 곧 시간순이므로 형식을 바꿀 필요가 없다 */
function isNewer(a: string, b: string): boolean {
  return a > b
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
      // 여기만 남았다
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
    firstSeenAt: mine.firstSeenAt <= theirs.firstSeenAt ? mine.firstSeenAt : theirs.firstSeenAt,
    lastSeenAt: isNewer(mine.lastSeenAt, theirs.lastSeenAt) ? mine.lastSeenAt : theirs.lastSeenAt,
  }
}

/** 서버 행과 비교할 때 — id/user_id 같은 서버 관리 값은 보지 않는다 */
function sameAsServer(a: WordStateRecord, b: WordStateRecord): boolean {
  return (
    a.status === b.status &&
    a.seenCount === b.seenCount &&
    a.firstSeenAt === b.firstSeenAt &&
    a.lastSeenAt === b.lastSeenAt
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
