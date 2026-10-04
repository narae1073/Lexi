import { useId } from 'react'

import {
  clampTextScale,
  TEXT_SCALE_DEFAULT,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'

/**
 * 화면 전체 글자 크기.
 *
 * 배율만 고르므로 미리보기는 실제 크기 그대로 보여주는 편이 낫다.
 * 예시는 짧게 유지한다 — 길면 몇 배율인지 가늠이 안 서서.
 */
export function TextScaleControl() {
  const t = useTranslation()
  const value = useSettingsStore((s) => s.textScale)
  const setValue = useSettingsStore((s) => s.setTextScale)
  const labelId = useId()

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p id={labelId} className="text-sm font-medium">
          {t('settings.textScale')}
        </p>
        <button
          type="button"
          onClick={() => setValue(TEXT_SCALE_DEFAULT)}
          disabled={value === TEXT_SCALE_DEFAULT}
          className="text-ink-muted hover:text-ink text-xs disabled:opacity-40"
        >
          {t('settings.reset')}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <span className="text-ink-muted text-xs" aria-hidden>
          A<span className="align-sub text-[0.7em]">a</span>
        </span>
        <input
          type="range"
          min={TEXT_SCALE_MIN}
          max={TEXT_SCALE_MAX}
          step={5}
          value={value}
          aria-labelledby={labelId}
          onChange={(event) => setValue(clampTextScale(Number(event.target.value)))}
          className="border-line accent-accent h-1 flex-1 cursor-pointer appearance-none rounded-full"
        />
        <span className="text-ink-muted text-xs" aria-hidden>
          A<span className="align-super text-[0.7em]">a</span>
        </span>
      </div>

      <p className="text-ink-muted mt-2 text-xs">
        {t('settings.textScaleHint', { value: String(clampTextScale(value)) })}
      </p>

      {/* 실제 배율이 그대로 반영되는 미리보기 */}
      <div className="border-line mt-3 rounded-lg border px-3 py-2">
        <p className="leading-[2.1]">{t('settings.textScalePreview')}</p>
      </div>
    </div>
  )
}
