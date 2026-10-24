import type { WordStateEvent } from './wordStateEvents'

export type TimelineRange = '1h' | '6h' | '24h' | '7d' | '30d' | 'all'
export type TimelineBucket = '5m' | '1h' | '12h' | '1d' | '1w'

export type TimelinePoint = {
  at: string
  known: number
  unsure: number
  new: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export const RANGE_MS: Record<Exclude<TimelineRange, 'all'>, number> = {
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
}

export const BUCKET_MS: Record<TimelineBucket, number> = {
  '5m': 5 * MINUTE,
  '1h': HOUR,
  '12h': 12 * HOUR,
  '1d': DAY,
  '1w': WEEK,
}

const BUCKETS: TimelineBucket[] = ['5m', '1h', '12h', '1d', '1w']
const MAX_AUTO_POINTS = 30

export function autoTimelineBucket(range: TimelineRange, spanMs: number): TimelineBucket {
  if (range !== 'all') {
    for (const bucket of BUCKETS) {
      if (Math.ceil(RANGE_MS[range] / BUCKET_MS[bucket]) <= MAX_AUTO_POINTS) {
        return bucket
      }
    }
  }
  for (const bucket of BUCKETS) {
    if (Math.ceil(spanMs / BUCKET_MS[bucket]) <= MAX_AUTO_POINTS) return bucket
  }
  return '1w'
}

/**
 * Replay events up to the beginning of the range, then accumulate at each
 * bucket boundary. The baseline events make the starting counts correct after
 * a fresh install/reset.
 */
export function buildWordStateTimeline(
  events: readonly WordStateEvent[],
  range: TimelineRange,
  bucket: TimelineBucket,
  now = Date.now(),
): TimelinePoint[] {
  if (events.length === 0) return []

  const first = Date.parse(events[0].occurredAt)
  const rangeStart =
    range === 'all' ? first : Math.max(first, now - RANGE_MS[range])
  const end = now
  if (!Number.isFinite(rangeStart) || end < rangeStart) return []

  const counts = { known: 0, unsure: 0, new: 0 }
  let eventIndex = 0
  const apply = (event: WordStateEvent) => {
    if (event.oldStatus === 'known') counts.known -= 1
    else if (event.oldStatus === 'unsure') counts.unsure -= 1
    else if (event.oldStatus === 'unknown') counts.new -= 1

    if (event.newStatus === 'known') counts.known += 1
    else if (event.newStatus === 'unsure') counts.unsure += 1
    else if (event.newStatus === 'unknown') counts.new += 1
  }

  while (eventIndex < events.length && Date.parse(events[eventIndex].occurredAt) <= rangeStart) {
    apply(events[eventIndex])
    eventIndex += 1
  }

  const points: TimelinePoint[] = [
    { at: new Date(rangeStart).toISOString(), ...counts },
  ]
  let cursor = rangeStart
  const step = BUCKET_MS[bucket]
  while (cursor < end) {
    const next = Math.min(cursor + step, end)
    while (eventIndex < events.length && Date.parse(events[eventIndex].occurredAt) <= next) {
      apply(events[eventIndex])
      eventIndex += 1
    }
    points.push({ at: new Date(next).toISOString(), ...counts })
    cursor = next
  }
  return points
}

/** Explicit bucket choices can be dense; keep the chart readable. */
export function downsampleTimeline(points: readonly TimelinePoint[], max = 120): TimelinePoint[] {
  if (points.length <= max) return [...points]
  const step = Math.ceil(points.length / max)
  const out: TimelinePoint[] = []
  for (let i = 0; i < points.length; i += step) out.push(points[i])
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1])
  return out
}
