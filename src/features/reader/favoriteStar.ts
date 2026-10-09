/**
 * 별 스티커의 기울기.
 *
 * 별이 생길 때마다 기울기를 랜덤으로 — 단, 렌더할 때마다 다시 뽑으면
 * 별이 덜덜 떨린다. 단어마다 고정된 '난수' 를 쓴다: 같은 단어는 어느 기기에서든
 * 같은 각도로 기울고, 다시 그려도 그대로다.
 */
export function starTilt(languageCode: string, lemma: string): number {
  const key = `${languageCode}::${lemma}`
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  const unit = (Math.abs(hash) % 1000) / 1000
  return Math.round(unit * 50 - 25)
}
