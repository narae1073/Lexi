import type { Document, Folder } from '../../types'
import type { DocumentTombstone } from '../storage/purged'
import type { WordStateRecord } from './merge'
import type { OccurrenceRow } from './mapping'

export type PullWatermarks = { snapshot?: string }

export type PullResult = {
  languages: string[]
  documents: Document[]
  tombstones: DocumentTombstone[]
  folders: Folder[]
  wordStates: WordStateRecord[]
  occurrences: OccurrenceRow[]
  totals: { documents: number; wordStates: number }
  watermarks: { snapshot: string }
}
