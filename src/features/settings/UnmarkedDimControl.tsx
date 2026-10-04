import { useId } from 'react'

import {
  clampUnmarkedDim,
  UNMARKED_DIM_DEFAULT,
  UNMARKED_DIM_MAX,
  UNMARKED_DIM_MIN,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'

/**
 * 표시 안 한 단어 색의 옅은 정도.
 *
 * 값을 바꾸면 위에서 바로 반영된다 — 본문이 두세 줄 보이고,
 * 문서에서 그 단어가 어떤 색인지 확인하며 고르는 편이 편하다.
 */
export function UnmarkedDimControl() {
  const t = useTranslation()
  const value = useSettingsStore((s) => s.unmarkedDim)
  const setValue = useSettingsStore((s) => s.setUnmarkedDim)
  const labelId = useId()

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p id={labelId} className="text-sm font-medium">
          {t('settings.unmarkedDim')}
        </p>
        <button
          type="button"
          onClick={() => setValue(UNMARKED_DIM_DEFAULT)}
          disabled={value === UNMARKED_DIM_DEFAULT}
          className="text-ink-muted hover:text-ink text-xs disabled:opacity-40"
        >
          {t('settings.reset')}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <span className="text-ink-muted text-xs" aria-hidden>
          {t('settings.dimStrong')}
        </span>
        <input
          type="range"
          min={UNMARKED_DIM_MIN}
          max={UNMARKED_DIM_MAX}
          step={1}
          value={value}
          aria-labelledby={labelId}
          onChange={(event) => setValue(clampUnmarkedDim(Number(event.target.value)))}
          className="border-line accent-accent h-1 flex-1 cursor-pointer appearance-none rounded-full"
        />
        <span className="text-ink-muted text-xs" aria-hidden>
          {t('settings.dimFaint')}
        </span>
      </div>

      <p className="text-ink-muted mt-2 text-xs">
        {t('settings.unmarkedDimHint', { value: String(clampUnmarkedDim(value)) })}
      </p>

      {/* 본문 색과 실제 적용색을 나란히 보여준다 */}
      <div className="border-line mt-3 rounded-lg border px-3 py-2">
        <p className="text-sm">
          <span className="text-ink">The</span>{' '}
          <span className="text-unmarked">untouched word</span>{' '}
          <span className="text-ink">known word</span>
        </p>
      </div>
    </div>
  )
}
