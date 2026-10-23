import type { Document } from '../../types'

/**
 * Whether opening this document may recompute and push its occurrence rows.
 *
 * A metadata-only document (`hasContent === false`) was created somewhere else
 * and its text arrived from the server. Recomputing it here would turn a read
 * into a content edit: it writes local occurrence rows, stamps
 * `documentMeta.occurrencesUpdatedAt`, and the next sync pushes them back as if
 * the user had changed something. Only a document whose text this device
 * authored may be recomputed; a synced document keeps the server's rows.
 */
export function mayRecomputeOccurrences(doc: Document): boolean {
  return doc.hasContent !== false
}
