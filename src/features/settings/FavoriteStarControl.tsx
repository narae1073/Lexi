import { useId, type CSSProperties } from 'react'

import {
  clampStarSize,
  STAR_COLOR_DEFAULT,
  STAR_SIZE_DEFAULT,
  STAR_SIZE_MAX,
  STAR_SIZE_MIN,
  STAR_SIZE_STEP,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'

/**
 * 즐겨찾기 별 스티커의 크기.
 *
 * 색은 별마다 랜덤이라 여기서 고르지 않는다 — 팝오버의 색바꾸기 버튼으로
 * 단어마다 바꾼다. 여기는 크기만, 미리보기와 함께.
 */
export function FavoriteStarControl() {
  const t = useTranslation()
  const size = useSettingsStore((s) => s.favoriteStarSize)
  const setSize = useSettingsStore((s) => s.setFavoriteStarSize)
  const sizeLabelId = useId()

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p id={sizeLabelId} className="text-sm font-medium">{t('settings.favoriteStar')}</p>
        <button
          type="button"
          onClick={() => setSize(STAR_SIZE_DEFAULT)}
          disabled={size === STAR_SIZE_DEFAULT}
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

      {/* 설정값 그대로의 미리보기 */}
      <div className="border-line mt-3 rounded-lg border px-3 py-2">
        <p className="text-ink-muted text-xs">{t('settings.favoriteStarPreview')}</p>
        <p className="mt-1 text-[1.05rem] leading-[2.1]">
          <span
            className="lexi-fav"
            style={
              {
                '--star-tilt': '-12deg',
                '--star-size': `${clampStarSize(size)}%`,
                '--star-color': STAR_COLOR_DEFAULT,
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
