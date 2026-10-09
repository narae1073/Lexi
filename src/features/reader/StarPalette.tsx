import { useTranslation } from '../../app/stores/settings'
import { STAR_SWATCHES, type StarSwatchName } from './favoriteStar'

/**
 * 별 색 고르기 — 흰빨주노초파남보검 9색.
 *
 * 팝오버 안에 펼쳐지는 작은 창이다. 별도 포털로 띄우면 바깥 클릭 감지가
 * 단어 팝오버부터 닫아 버려 색을 고르기도 전에 사라진다 — 같은 박스 안에
 * 두어야 산다.
 */
export function StarPalette({
  current,
  onPick,
}: {
  current: string | undefined
  onPick: (hex: string) => void
}) {
  const t = useTranslation()

  return (
    <div
      role="group"
      aria-label={t('favorite.pickColor')}
      className="border-line mt-1 grid grid-cols-9 gap-1 rounded-lg border p-1.5"
    >
      {STAR_SWATCHES.map((swatch) => {
        const active = current?.toLowerCase() === swatch.hex
        return (
          <button
            key={swatch.name}
            type="button"
            data-star-color={swatch.hex}
            onClick={() => onPick(swatch.hex)}
            aria-pressed={active}
            aria-label={t(`favorite.colors.${swatch.name as StarSwatchName}`)}
            title={t(`favorite.colors.${swatch.name as StarSwatchName}`)}
            className={`pointer-events-auto flex h-6 items-center justify-center rounded-md transition hover:opacity-80 ${
              active ? 'ring-accent ring-2 ring-offset-1' : ''
            }`}
          >
            <span
              aria-hidden
              className="border-line block h-4 w-4 rounded-full border"
              style={{ backgroundColor: swatch.hex }}
            />
          </button>
        )
      })}
    </div>
  )
}
