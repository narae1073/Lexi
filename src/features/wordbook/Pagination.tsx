import { pageWindow, type Page } from '../../lib/paginate'
import { useTranslation } from '../../app/stores/settings'

type PaginationProps = {
  page: Page<unknown>
  onPageChange: (page: number) => void
}

/**
 * 페이지 이동 UI.
 *
 * 한 페이지만 담기는 동안은 숨긴다 — 1 / 1 을 보여주는 것은 아무 정보도 주지
 * 않으면서 화면만 차지한다.
 *
 * '한 쪽에 몇 개씩 볼지'는 PageSizeSelect 가 목록 위에 따로 맡고 있다.
 */
export function Pagination({ page, onPageChange }: PaginationProps) {
  const t = useTranslation()

  if (page.pageCount <= 1) return null

  return (
    <nav
      aria-label={t('pagination.label')}
      className="border-line mt-5 flex flex-col items-center gap-3 border-t pt-4"
    >
      <p className="text-ink-muted text-xs">
        {t('pagination.range', { from: page.from, to: page.to, total: page.total })}
      </p>

      <div className="flex items-center gap-1">
        <StepButton
          label={t('pagination.prev')}
          disabled={!page.hasPrev}
          onClick={() => onPageChange(page.page - 1)}
        >
          ‹
        </StepButton>

        {pageWindow(page.page, page.pageCount).map((entry, index) =>
          entry === 'gap' ? (
            <span key={`gap-${index}`} className="text-ink-muted px-1 text-sm" aria-hidden>
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              onClick={() => onPageChange(entry)}
              aria-current={entry === page.page ? 'page' : undefined}
              className={
                entry === page.page
                  ? 'bg-accent text-accent-ink h-8 min-w-8 rounded-lg px-2 text-sm'
                  : 'text-ink-muted hover:text-ink hover:border-accent h-8 min-w-8 rounded-lg border border-transparent px-2 text-sm'
              }
            >
              {entry}
            </button>
          ),
        )}

        <StepButton
          label={t('pagination.next')}
          disabled={!page.hasNext}
          onClick={() => onPageChange(page.page + 1)}
        >
          ›
        </StepButton>
      </div>
    </nav>
  )
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="text-ink-muted hover:text-ink hover:border-accent h-8 min-w-8 rounded-lg border border-transparent px-2 disabled:opacity-30"
    >
      {children}
    </button>
  )
}
