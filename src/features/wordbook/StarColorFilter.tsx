import { useTranslation } from '../../app/stores/settings'
import { STAR_SWATCHES, type StarSwatchName } from '../reader/favoriteStar'

/**
 * ★ 탭의 별 색 필터 — 색창의 9색을 겹쳐 켠다.
 *
 * 팝오버의 색창(StarPalette)과 같은 팔레트지만 거기서는 '하나를 고른다' 고
 * 여기서는 '켜고 끈다' 로 다르다. 켠 색이 없으면 좁히지 않는다 — 전부 보인다.
 *
 * 문서 팝오버처럼 포털로 띄우지 않는다 — 목록 위 한 줄이므로 박스가 떠 있을
 * 이유가 없고, 겹쳐 켜는 상태가 화면에 늘 보여야 좁혀진 목록을 읽을 수 있다.
 */
export function StarColorFilter({
  active,
  onToggle,
}: {
  /** 지금 켠 색 (소문자 hex) */
  active: readonly string[]
  onToggle: (hex: string) => void
}) {
  const t = useTranslation()

  return (
    <div
      role="group"
      aria-label={t('wordbook.starColorFilter')}
      className="mb-3 flex flex-wrap items-center gap-1.5"
    >
      {STAR_SWATCHES.map((swatch) => {
        const on = active.includes(swatch.hex)
        return (
          <button
            key={swatch.name}
            type="button"
            data-star-filter={swatch.hex}
            onClick={() => onToggle(swatch.hex)}
            aria-pressed={on}
            aria-label={t(`favorite.colors.${swatch.name as StarSwatchName}`)}
            title={t(`favorite.colors.${swatch.name as StarSwatchName}`)}
            className={
              on
                ? 'border-accent ring-accent rounded-md border p-1 ring-2 ring-offset-1'
                : 'border-line hover:border-accent rounded-md border p-1 transition'
            }
          >
            <span
              aria-hidden
              className="block h-4 w-4 rounded-full border"
              style={{ backgroundColor: swatch.hex }}
            />
          </button>
        )
      })}
    </div>
  )
}
