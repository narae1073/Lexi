import type { WordOccurrence } from '../../app/stores/occurrences'

/**
 * Whether two occurrence lists carry the same **content**.
 *
 * Rewriting rows every time a document is reopened makes IndexedDB delete and
 * re-insert everything even though nothing the user can see changed, and sync
 * then sends the document as if it were edited. The larger the library, the
 * more of that wasted work adds up.
 *
 * So the decision to write is based only on meaningful content:
 * - document, language, lemma, surfaces, count, character range and sentence
 *   are content;
 * - `recordedAt` is just the last computation time and `documentTitle` is a
 *   display copy, so a renamed document is not an occurrence change.
 *
 * Storage order can differ between writes, so both lists are sorted by
 * `(documentId, languageCode, lemma)` before comparing.
 */
export function sameOccurrenceRecords(
  existing: readonly WordOccurrence[],
  next: readonly WordOccurrence[],
): boolean {
  if (existing.length !== next.length) return false
  const a = [...existing].sort(compareRecords)
  const b = [...next].sort(compareRecords)
  return a.every((record, i) => sameRecord(record, b[i]))
}

function compareRecords(a: WordOccurrence, b: WordOccurrence): number {
  return (
    compareText(a.documentId, b.documentId) ||
    compareText(a.languageCode, b.languageCode) ||
    compareText(a.lemma, b.lemma)
  )
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sameRecord(a: WordOccurrence, b: WordOccurrence): boolean {
  return (
    a.documentId === b.documentId &&
    a.languageCode === b.languageCode &&
    a.lemma === b.lemma &&
    a.count === b.count &&
    a.charStart === b.charStart &&
    a.charEnd === b.charEnd &&
    a.sentence === b.sentence &&
    sameSurfaces(a.surfaces, b.surfaces)
  )
}

/** Surfaces are a set — the order they were collected in carries no meaning. */
function sameSurfaces(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((surface, i) => surface === right[i])
}
