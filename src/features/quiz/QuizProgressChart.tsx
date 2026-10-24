import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import { useTranslation } from '../../app/stores/settings'
import type { LanguageCode } from '../../types'
import {
  readWordStateEvents,
  subscribeWordStateEvents,
  type WordStateEvent,
} from '../../lib/storage/wordStateEvents'
import {
  autoTimelineBucket,
  buildWordStateTimeline,
  BUCKET_MS,
  downsampleTimeline,
  type TimelineBucket,
  type TimelinePoint,
  type TimelineRange,
} from '../../lib/storage/wordStateTimeline'
import { Popover } from '../reader/Popover'

const RANGES: TimelineRange[] = ['1h', '6h', '24h', '7d', '30d', 'all']
const BUCKETS: TimelineBucket[] = ['5m', '1h', '12h', '1d', '1w']
const MAX_VISIBLE_POINTS = 40

const RANGE_LABEL: Record<
  TimelineRange,
  | 'quiz.range1h'
  | 'quiz.range6h'
  | 'quiz.range24h'
  | 'quiz.range7d'
  | 'quiz.range30d'
  | 'quiz.rangeAll'
> = {
  '1h': 'quiz.range1h',
  '6h': 'quiz.range6h',
  '24h': 'quiz.range24h',
  '7d': 'quiz.range7d',
  '30d': 'quiz.range30d',
  all: 'quiz.rangeAll',
}

const BUCKET_LABEL: Record<
  TimelineBucket,
  | 'quiz.bucket5m'
  | 'quiz.bucket1h'
  | 'quiz.bucket12h'
  | 'quiz.bucket1d'
  | 'quiz.bucket1w'
> = {
  '5m': 'quiz.bucket5m',
  '1h': 'quiz.bucket1h',
  '12h': 'quiz.bucket12h',
  '1d': 'quiz.bucket1d',
  '1w': 'quiz.bucket1w',
}

function formatTime(at: string, range: TimelineRange): string {
  const date = new Date(at)
  const options: Intl.DateTimeFormatOptions =
    range === '1h' || range === '6h'
      ? { hour: 'numeric', minute: '2-digit' }
      : range === '24h'
        ? { weekday: 'short', hour: 'numeric' }
        : { month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(undefined, options).format(date)
}

function formatBucket(at: string, bucket: TimelineBucket): string {
  const end = new Date(at)
  const start = new Date(end.getTime() - BUCKET_MS[bucket])
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${formatter.format(start)} – ${formatter.format(end)}`
}

function LegendMark({ style }: { style: 'solid' | 'dashed' | 'dotted' }) {
  return (
    <span
      aria-hidden
      className={`inline-block w-5 border-t-2 ${
        style === 'solid'
          ? 'border-solid'
          : style === 'dashed'
            ? 'border-dashed'
            : 'border-dotted'
      }`}
    />
  )
}

/**
 * Wordbook composition over time for one language.
 *
 * Events are stored in reserved documentMeta rows (no IndexedDB version bump).
 * The chart is a device-local view: it starts at this device's baseline and
 * starts over when local storage is cleared.
 */
export function QuizProgressChart({ languageCode }: { languageCode: LanguageCode }) {
  const t = useTranslation()
  const [events, setEvents] = useState<WordStateEvent[]>([])
  const [eventsReady, setEventsReady] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [range, setRange] = useState<TimelineRange>('7d')
  const [explicitBucket, setExplicitBucket] = useState<TimelineBucket | null>(null)
  const [selected, setSelected] = useState<{ point: TimelinePoint; anchor: HTMLElement } | null>(
    null,
  )

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        void readWordStateEvents(languageCode)
          .then((next) => {
            if (cancelled) return
            setEvents(next)
            setNow(Date.now())
            setEventsReady(true)
          })
          .catch(() => {
            if (!cancelled) setEventsReady(true)
          })
      }, 0)
    }

    load()
    const unsubscribe = subscribeWordStateEvents(load)
    return () => {
      cancelled = true
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [languageCode])

  const span = useMemo(() => {
    if (events.length === 0) return 0
    return Math.max(0, now - Date.parse(events[0].occurredAt))
  }, [events, now])

  const autoBucket = autoTimelineBucket(range, span)
  const bucket = explicitBucket ?? autoBucket
  const rawPoints = useMemo(
    () => buildWordStateTimeline(events, range, bucket, now),
    [events, range, bucket, now],
  )
  const points = useMemo(
    () => downsampleTimeline(rawPoints, MAX_VISIBLE_POINTS),
    [rawPoints],
  )
  const downsampled = points.length < rawPoints.length

  if (!eventsReady) {
    return (
      <section data-quiz-progress className="border-line mt-6 rounded-xl border px-4 py-3">
        <p className="text-ink-muted text-xs">{t('dictionary.loading')}</p>
      </section>
    )
  }

  if (events.length === 0 || points.length === 0) {
    return (
      <section data-quiz-progress className="border-line mt-6 rounded-xl border px-4 py-3">
        <h2 className="text-sm font-medium">{t('quiz.progressTitle')}</h2>
        <p className="text-ink-muted mt-1 text-xs leading-relaxed">{t('quiz.progressEmpty')}</p>
      </section>
    )
  }

  return (
    <section data-quiz-progress className="border-line mt-6 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{t('quiz.progressTitle')}</h2>
        <div className="flex items-center gap-2">
          <label className="text-ink-muted flex items-center gap-1 text-xs">
            {t('quiz.progressRange')}
            <select
              value={range}
              onChange={(event) => {
                setRange(event.target.value as TimelineRange)
                setExplicitBucket(null)
                setSelected(null)
              }}
              className="border-line bg-surface rounded border px-1 py-0.5 text-xs"
            >
              {RANGES.map((value) => (
                <option key={value} value={value}>
                  {t(RANGE_LABEL[value])}
                </option>
              ))}
            </select>
          </label>
          <label className="text-ink-muted flex items-center gap-1 text-xs">
            {t('quiz.progressBucket')}
            <select
              value={bucket}
              onChange={(event) => {
                setExplicitBucket(event.target.value as TimelineBucket)
                setSelected(null)
              }}
              className="border-line bg-surface rounded border px-1 py-0.5 text-xs"
            >
              {BUCKETS.map((value) => (
                <option key={value} value={value}>
                  {t(BUCKET_LABEL[value])}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" data-quiz-progress-legend>
        <span className="text-ink flex items-center gap-1.5">
          <LegendMark style="solid" />
          {t('quiz.summaryKnown')}
        </span>
        <span className="text-ink flex items-center gap-1.5">
          <LegendMark style="dashed" />
          {t('quiz.summaryUnsure')}
        </span>
        <span className="text-ink flex items-center gap-1.5">
          <LegendMark style="dotted" />
          {t('quiz.summaryNew')}
        </span>
      </div>

      <div className="relative mt-2">
        <div
          className="h-[240px] w-full"
          role="img"
          aria-label={t('quiz.progressTitle')}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 28, left: 42 }}>
              <CartesianGrid stroke="var(--color-line)" vertical={false} />
              <XAxis
                dataKey="at"
                tickFormatter={(value: string) => formatTime(value, range)}
                tick={{ fill: 'var(--color-ink-muted)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--color-line)' }}
                tickLine={{ stroke: 'var(--color-line)' }}
                minTickGap={20}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: 'var(--color-ink-muted)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--color-line)' }}
                tickLine={{ stroke: 'var(--color-line)' }}
                width={36}
              />
              <Line
                type="monotone"
                dataKey="known"
                stroke="var(--color-ink)"
                strokeWidth={2}
                dot={{ r: 2.5 }}
                activeDot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="unsure"
                stroke="var(--color-status-unsure)"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={{ r: 2.5 }}
                activeDot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="new"
                stroke="var(--color-status-unknown)"
                strokeWidth={2}
                strokeDasharray="2 3"
                dot={{ r: 3 }}
                activeDot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Equal-width transparent controls make the whole bucket column, not
            just a tiny dot, a touch target. */}
        <div
          className="absolute flex"
          style={{ top: 8, left: 42, right: 12, bottom: 28 }}
          aria-label={t('quiz.progressTitle')}
        >
          {points.map((point) => (
            <button
              key={point.at}
              type="button"
              data-quiz-progress-point={point.at}
              aria-label={`${formatBucket(point.at, bucket)}: ${t('quiz.summaryKnown')} ${point.known}, ${t('quiz.summaryUnsure')} ${point.unsure}, ${t('quiz.summaryNew')} ${point.new}`}
              onClick={(event) =>
                setSelected({ point, anchor: event.currentTarget })
              }
              className="focus-visible:outline-accent h-full min-w-0 flex-1 cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
            />
          ))}
        </div>
      </div>

      {downsampled && (
        <p className="text-status-unsure mt-1 text-[10px]" role="status">
          {t('quiz.progressDownsampled', {
            shown: points.length,
            total: rawPoints.length,
          })}
        </p>
      )}

      <details className="mt-3">
        <summary className="text-ink-muted cursor-pointer text-xs">
          {t('quiz.progressTable')}
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table data-quiz-progress-table className="w-full text-left text-[11px]">
            <caption className="sr-only">{t('quiz.progressTitle')}</caption>
            <thead>
              <tr className="border-line border-b">
                <th className="py-1 pr-2 font-medium">{t('quiz.progressTime')}</th>
                <th className="py-1 pr-2 font-medium">{t('quiz.summaryKnown')}</th>
                <th className="py-1 pr-2 font-medium">{t('quiz.summaryUnsure')}</th>
                <th className="py-1 font-medium">{t('quiz.summaryNew')}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.at} className="border-line border-b last:border-0">
                  <td className="py-1 pr-2 tabular-nums">{formatBucket(point.at, bucket)}</td>
                  <td className="py-1 pr-2 tabular-nums">{point.known}</td>
                  <td className="py-1 pr-2 tabular-nums">{point.unsure}</td>
                  <td className="py-1 tabular-nums">{point.new}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {selected && (
        <Popover
          anchor={selected.anchor}
          anchorKey={`quiz-progress:${selected.point.at}`}
          onClose={() => setSelected(null)}
          width={240}
        >
          <div data-quiz-progress-tooltip>
            <p className="text-xs font-medium">{formatBucket(selected.point.at, bucket)}</p>
            <dl className="mt-1 grid grid-cols-3 gap-1 text-xs">
              <div>
                <dt className="text-ink-muted">{t('quiz.summaryKnown')}</dt>
                <dd className="tabular-nums">{selected.point.known}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('quiz.summaryUnsure')}</dt>
                <dd className="tabular-nums">{selected.point.unsure}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('quiz.summaryNew')}</dt>
                <dd className="tabular-nums">{selected.point.new}</dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-ink-muted hover:text-ink mt-2 text-[10px] underline"
            >
              {t('settings.close')}
            </button>
          </div>
        </Popover>
      )}
    </section>
  )
}
