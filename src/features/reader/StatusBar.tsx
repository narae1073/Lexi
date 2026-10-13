import { statusDotClass } from '../../lib/color'
import { useTranslation } from '../../app/stores/settings'
import type { WordStatus } from '../../types'

export type DocumentStats = {
  /** 중복을 뺀 서로 다른 단어 수 — 상태별 개수의 합과 같아야 한다 */
  uniqueWords: number
  /** 등장 횟수 기준 총 단어 수 */
  occurrences: number
  byStatus: Record<WordStatus | 'unmarked', number>
}

const ORDER: (WordStatus | 'unmarked')[] = ['known', 'unsure', 'unknown', 'unmarked']

/**
 * 화면 맨 아래 상태 바 (plan.txt 8줄).
 *
 * 개수는 중복을 뺀 기준이다. "the" 가 백 번 나와도 배워야 할 단어는 하나이고,
 * 등장 횟수로 세면 진도를 볼 수 없게 된다. 문서 머리말의 총 단어 수(등장 횟수)와
 * 값이 달라질 수 있으니 바 안에서 그 구분을 밝힌다.
 */
export function StatusBar({ stats }: { stats: DocumentStats }) {
  const t = useTranslation()

  const marked = stats.byStatus.known + stats.byStatus.unsure + stats.byStatus.unknown
  const percent = stats.uniqueWords === 0 ? 0 : Math.round((marked / stats.uniqueWords) * 100)

  return (
    <aside
      aria-label={t('statusBar.label')}
      // 팝오버가 이 바를 덮지 않게 — 아래쪽 여백에서 이 높이를 뺀다
      data-obstructs-bottom
      className="border-line bg-surface/95 fixed inset-x-0 bottom-0 z-20 border-t backdrop-blur"
    >
      <div className="mx-auto w-full max-w-2xl px-5 py-2">
        <div className="text-ink-muted flex items-baseline justify-between gap-3 text-xs">
          <span className="text-ink font-medium">{t('statusBar.total', { count: stats.uniqueWords })}</span>
          <span>{t('statusBar.percent', { percent })}</span>
        </div>

        {/* 진행률 — 표시한 단어가 어디까지인지 */}
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('statusBar.label')}
          className="bg-line mt-1.5 h-1 w-full overflow-hidden rounded-full"
        >
          <div className="bg-accent h-full rounded-full transition-[width]" style={{ width: `${percent}%` }} />
        </div>

        <ul className="text-ink-muted mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {ORDER.map((status) => (
            <li key={status} className="flex items-center gap-1.5">
              {/* 상태 색을 그대로 쓴다 — 막대와 설명이 같은 색을 말해야 한다 */}
              <span className={`rounded-sm px-1 ${statusDotClass(status)}`} aria-hidden>
                ●
              </span>
              {t(`statusBar.status.${status}`)}
              <span className="text-ink font-medium tabular-nums">{stats.byStatus[status]}</span>
            </li>
          ))}
          <li className="text-ink-muted/70 flex items-center gap-1.5">
            {t('statusBar.occurrences', { count: stats.occurrences })}
          </li>
        </ul>
      </div>
    </aside>
  )
}
