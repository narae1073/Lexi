import { useId, type CSSProperties } from 'react'

import {
  sanitizeStarColor,
  clampStarSize,
  STAR_COLOR_DEFAULT,
  STAR_SIZE_DEFAULT,
  STAR_SIZE_MAX,
  STAR_SIZE_MIN,
  STAR_SIZE_STEP,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'
import { starTilt } from '../reader/favoriteStar'

/**
 * 즐겨찾기 별 스티커의 생김새.
 *
 * 크기는 단어 글자의 %, 색은 고르는 대로. 미리보기는 설정값 그대로 보여준다 —
 * 글로 설명하는 것보다 그 자리에서 보는 편이 빠르다.
 */
export function FavoriteStarControl() {
  const t = useTranslation()
  const size = useSettingsStore((s) => s.favoriteStarSize)
  const setSize = useSettingsStore((s) => s.setFavoriteStarSize)
  const color = useSettingsStore((s) => s.favoriteStarColor)
  const setColor = useSettingsStore((s) => s.setFavoriteStarColor)
  const sizeLabelId = useId()
  const colorLabelId = useId()

  const isDefault = size === STAR_SIZE_DEFAULT && color === STAR_COLOR_DEFAULT

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p id={sizeLabelId} className="text-sm font-medium">{t('settings.favoriteStar')}</p>
        <button
          type="button"
          onClick={() => {
            setSize(STAR_SIZE_DEFAULT)
            setColor(STAR_COLOR_DEFAULT)
          }}
          disabled={isDefault}
          className="text-ink-muted hover:text-ink text-xs disabled:opacity-40"
        >
          {t('settings.reset')}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <span className="text-ink-muted text-xs" aria-hidden>
          {t('settings.starSmall')}
        </span>
        <input
          type="range"
          min={STAR_SIZE_MIN}
          max={STAR_SIZE_MAX}
          step={STAR_SIZE_STEP}
          value={size}
          aria-labelledby={sizeLabelId}
          onChange={(event) => setSize(clampStarSize(Number(event.target.value)))}
          className="border-line accent-accent h-1 flex-1 cursor-pointer appearance-none rounded-full"
        />
        <span className="text-ink-muted text-xs" aria-hidden>
          {t('settings.starLarge')}
        </span>
      </div>

      <p className="text-ink-muted mt-2 text-xs">
        {t('settings.favoriteStarSizeHint', { value: String(clampStarSize(size)) })}
      </p>

      <div className="mt-3 flex items-center gap-3">
        <label id={colorLabelId} className="text-ink-muted text-xs">
          {t('settings.favoriteStarColor')}
        </label>
        <input
          type="color"
          value={sanitizeStarColor(color)}
          aria-labelledby={colorLabelId}
          onChange={(event) => setColor(event.target.value)}
          className="border-line h-8 w-12 cursor-pointer rounded-lg border bg-surface p-1"
        />
      </div>

      {/* 설정값 그대로의 미리보기 — 기울기는 단어마다 다르므로 고정된 예시 */}
      <div className="border-line mt-3 rounded-lg border px-3 py-2">
        <p className="text-ink-muted text-xs">{t('settings.favoriteStarPreview')}</p>
        <p className="mt-1 text-[1.05rem] leading-[2.1]">
          <span
            className="lexi-fav"
            style={
              {
                '--star-tilt': `${starTilt('en', 'example')}deg`,
                '--star-size': `${clampStarSize(size)}%`,
                '--star-color': sanitizeStarColor(color),
              } as CSSProperties
            }
          >
            example
          </span>
        </p>
      </div>
    </div>
  )
}
