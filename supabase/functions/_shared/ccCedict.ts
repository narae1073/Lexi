/**
 * CC-CEDICT 파싱 + 병음 성조 부호.
 *
 * MDBG 공개 덤프(무료, CC BY-SA) 한 줄:
 *   北京大學 北京大学 [Bei3 jing1 Da4 xue2] /Peking University/
 *
 * Edge Function 과 적재 스크립트가 함께 쓴다 — 파싱이 두 곳에서 어긋나면
 * 넣은 것과 찾는 것이 달라진다.
 */

export type CedictEntry = {
  traditional: string
  simplified: string
  /** 숫자 성조 병음 (예: 'Bei3 jing1 Da4 xue2') */
  pinyin: string
  glosses: string[]
}

/**
 * 한 줄을 파싱한다. 주석·빈 줄은 null.
 *
 * 행이 깨져도 전체 적재가 죽으면 안 된다 — null 인 줄은 건너뛴다.
 */
export function parseCedictLine(line: string): CedictEntry | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const match = trimmed.match(/^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.*)\/\s*$/)
  if (!match) return null

  const glosses = match[4].split('/').map((g) => g.trim()).filter(Boolean)
  if (glosses.length === 0) return null

  return {
    traditional: match[1],
    simplified: match[2],
    pinyin: match[3].trim(),
    glosses,
  }
}

const TONE_MARKS: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  'ü': ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
  A: ['Ā', 'Á', 'Ǎ', 'À'],
  E: ['Ē', 'É', 'Ě', 'È'],
  I: ['Ī', 'Í', 'Ǐ', 'Ì'],
  O: ['Ō', 'Ó', 'Ǒ', 'Ò'],
  U: ['Ū', 'Ú', 'Ǔ', 'Ù'],
  'Ü': ['Ǖ', 'Ǘ', 'Ǚ', 'Ǜ'],
}

/**
 * 숫자 성조를 부호로 바꾼다 — 'Bei3 jing1' → 'Běi jīng'.
 *
 * 규칙(표준): a > o > e > iu·ui(뒤 모음) > 마지막 모음.
 * u: 는 ü 다. 5성·무표기는 숫자만 뗀다 (le5 → le).
 */
export function pinyinToneMarks(numbered: string): string {
  return numbered
    .split(/\s+/)
    .filter(Boolean)
    .map(markSyllable)
    .join(' ')
}

function markSyllable(syllable: string): string {
  const toneMatch = syllable.match(/([1-5])$/)
  const tone = toneMatch ? Number(toneMatch[1]) : 5
  let base = toneMatch ? syllable.slice(0, -1) : syllable
  base = base.replace(/u:/g, 'ü').replace(/U:/g, 'Ü')
  if (tone < 1 || tone > 4) return base

  const lower = base.toLowerCase()
  let at = lower.indexOf('a')
  if (at === -1) at = lower.indexOf('o')
  if (at === -1) at = lower.indexOf('e')
  if (at === -1) {
    // iu·ui 는 뒤 모음에 찍는다 (liu2 → liú, gui4 → guì)
    const iu = lower.indexOf('iu')
    const ui = lower.indexOf('ui')
    if (iu !== -1) at = iu + 1
    else if (ui !== -1) at = ui + 1
    else {
      // 마지막 모음
      const vowels = ['a', 'e', 'i', 'o', 'u', 'ü']
      for (let i = base.length - 1; i >= 0; i--) {
        if (vowels.includes(lower[i])) {
          at = i
          break
        }
      }
    }
  }
  if (at === -1) return base

  const mark = TONE_MARKS[base[at]]?.[tone - 1]
  return mark ? base.slice(0, at) + mark + base.slice(at + 1) : base
}
