/**
 * 별 스티커의 기울기와 색.
 *
 * 별이 생길 때마다(붙일 때마다, 색을 바꿀 때마다) 새로 뽑는다 — 같은 단어도
 * 매번 다르게 기울고 다른 색이 된다. 렌더할 때마다 뽑으면 별이 덜덜 떨리므로,
 * 뽑은 값은 단어 상태에 저장해 두고 그린다.
 */

/** 스티커다운 색만 — 너무 옅거나 어두우면 별이 묻힌다 */
export const STAR_COLORS = [
  '#eab308',
  '#ef4444',
  '#ec4899',
  '#f97316',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#14b8a3',
] as const

/** -25도에서 25도 사이 */
export function randomStarAngle(): number {
  return Math.floor(Math.random() * 51) - 25
}

/**
 * 팔레트에서 하나 뽑는다.
 *
 * 지금 색은 빼고 뽑는다 — 눌렀는데 같은 색이 나오면 버튼이 고장 난 것처럼 보인다.
 * 뺄 것이 없으면(팔레트가 비는 일은 없지만) 그대로 둔다.
 */
export function randomStarColor(exclude?: string): string {
  const candidates = STAR_COLORS.filter((color) => color !== exclude)
  const pool = candidates.length > 0 ? candidates : STAR_COLORS
  return pool[Math.floor(Math.random() * pool.length)] ?? STAR_COLORS[0]
}
