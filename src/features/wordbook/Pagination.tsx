import { pageWindow, type Page } from "../../lib/paginate";
import { useTranslation } from "../../app/stores/settings";

type PaginationProps = {
  page: Page<unknown>;
  onPageChange: (page: number) => void;
  /** 한 페이지에 몇 개씩 볼지 선택지를 띄울지 */
  pageSizes?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
};

/**
 * 페이지 이동 UI.
 *
 * 항목이 한 페이지만 담기는 동안은 페이지 버튼을 숨긴다 — 1 / 1 을 보여주는
 * 것은 아무 정보도 주지 않으면서 화면만 차지한다.
 *
 * 다만 '한 쪽에 몇 개씩 볼지'는 그대로 둔다. 이것까지 함께 숨기면 지금 몇 개로
 * 보고 있는지 알 수도 없고, 50 개로 크게 해 둔 뒤 단어가 줄어 한 쪽이 되면
 * 되돌릴 방법이 사라진다.
 */
export function Pagination({
  page,
  onPageChange,
  pageSizes,
  onPageSizeChange,
}: PaginationProps) {
  const t = useTranslation();

  const showPages = page.pageCount > 1;
  const showSizes = Boolean(pageSizes && onPageSizeChange);

  if (!showPages && !showSizes) return null;

  return (
    <nav
      aria-label={t("pagination.label")}
      className="border-line mt-5 flex flex-col items-center gap-3 border-t pt-4"
    >
      {showPages && (
        <p className="text-ink-muted text-xs">
          {t("pagination.range", {
            from: page.from,
            to: page.to,
            total: page.total,
          })}
        </p>
      )}

      {showPages && (
        <div className="flex items-center gap-1">
          <StepButton
            label={t("pagination.prev")}
            disabled={!page.hasPrev}
            onClick={() => onPageChange(page.page - 1)}
          >
            ‹
          </StepButton>

          {pageWindow(page.page, page.pageCount).map((entry, index) =>
            entry === "gap" ? (
              <span
                key={`gap-${index}`}
                className="text-ink-muted px-1 text-sm"
                aria-hidden
              >
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                onClick={() => onPageChange(entry)}
                aria-current={entry === page.page ? "page" : undefined}
                className={
                  entry === page.page
                    ? "bg-accent text-accent-ink h-8 min-w-8 rounded-lg px-2 text-sm"
                    : "text-ink-muted hover:text-ink hover:border-accent h-8 min-w-8 rounded-lg border border-transparent px-2 text-sm"
                }
              >
                {entry}
              </button>
            ),
          )}

          <StepButton
            label={t("pagination.next")}
            disabled={!page.hasNext}
            onClick={() => onPageChange(page.page + 1)}
          >
            ›
          </StepButton>
        </div>
      )}

      {pageSizes && onPageSizeChange && (
        <label className="text-ink-muted flex items-center gap-2 text-xs">
          {t("pagination.size")}
          <select
            value={page.pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="border-line focus:border-accent rounded-lg border bg-surface px-2 py-1 text-sm outline-none"
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      )}
    </nav>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
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
  );
}
