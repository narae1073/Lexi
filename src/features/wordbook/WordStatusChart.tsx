import { statusClass } from '../../lib/color'
import { useTranslation } from '../../app/stores/settings'
import { CHART_ORDER, FILL_CLASS, percentages, segments, type StatusCounts } from './statusChart'

/**
 * 선택한 언어의 단어 상태를 한 줄로 쌓은 게이지.
 *
 * 왜 한 줄인가: 네 상태를 따로 그리는 것은 서로의 크기를 비교하게 만든다. 한 줄이면
 * '전체 중 각자 몫' 이 한 번에 보인다 — 이것만 알고 싶으므로.
 */
export function WordStatusChart({ counts }: { counts: StatusCounts }) {
  const t = useTranslation()

  const shares = percentages(counts)
  const total = CHART_ORDER.reduce((sum, key) => sum + counts[key], 0)

  /**
   * 하나도 없으면 빈 막대만 둔다 — '0%' 라고 읽히면 안 된다.
   *
   * 기록이 없다는 것은 진도가 0 이라는 뜻이 아니라, 아직 이 기기에서 모은 것이 없다는
   * 뜻이다. 상태 바도 이 구분을 한다.
   */
  if (total === 0) {
    return <div className="bg-line/60 h-2 w-full rounded-full" aria-hidden="true" />
  }

  return (
    <div>
      <div
        role="img"
        aria-label={CHART_ORDER.map(
          (key) => `${t(`statusBar.status.${key}`)} ${counts[key]} (${shares[key]}%)`,
        ).join(', ')}
        className="flex h-2 w-full overflow-hidden rounded-full"
      >
        {segments(counts).map(({ key, percent }) => (
          <span key={key} style={{ width: `${percent}%` }} className={FILL_CLASS[key]} />
        ))}
      </div>

      {/* 각 상태가 전체에서 몇 % 인지 — 막대만으로는 정확히 읽히지 않는다 */}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {CHART_ORDER.map((key) => (
          <li key={key} className="text-ink-muted flex items-center gap-1.5">
            <span className={`text-[10px] ${statusClass(key)}`} aria-hidden="true">
              ●
            </span>
            <span className="whitespace-nowrap">{t(`statusBar.status.${key}`)}</span>
            <span className="text-ink tabular-nums">{counts[key]}</span>
            <span className="tabular-nums">{shares[key]}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}