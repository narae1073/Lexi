import { useId } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { PAGE_SIZES } from '../../lib/paginate'

/**
 * 한 쪽에 몇 개씩 볼지 고르는 곳.
 *
 * 목록 아래에 두면 길게 스크롤한 뒤에야 바꿀 수 있다 — 몇 개의 단어가 화면을
 * 차지하는지 먼저 보고 고르는 쪽이 자연스럽기 때문에 목록 위로 올렸다.
 * 한 쪽에 다 들어가는 동안에도 항상 보인다.
 */
export function PageSizeSelect({
  value,
  onChange,
}: {
  value: number
  onChange: (pageSize: number) => void
}) {
  const t = useTranslation()
  const labelId = useId()

  return (
    <div className="mb-2 flex justify-end">
      <label htmlFor={labelId} className="text-ink-muted flex items-center gap-1.5 text-xs">
        {t('pagination.size')}
        <select
          id={labelId}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="border-line focus:border-accent rounded-lg border bg-surface px-2 py-1 text-sm outline-none"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        {t('pagination.unit')}
      </label>
    </div>
  )
}
