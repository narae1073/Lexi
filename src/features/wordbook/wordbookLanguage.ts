import type { LanguageCode } from '../../types'

/**
 * Which language the Wordbook should open with.
 *
 * A valid `?lang=` link wins (document links and shared URLs), then the last
 * language chosen on this device, then the first enrolled language. The stored
 * value deliberately does not win when that language is no longer enrolled.
 */
export function wordbookLanguageOrDefault(
  requested: string | null | undefined,
  stored: string | null | undefined,
  enrolled: readonly LanguageCode[],
): LanguageCode | null {
  const available = new Set<string>(enrolled)
  if (typeof requested === 'string' && available.has(requested)) {
    return requested as LanguageCode
  }
  if (typeof stored === 'string' && available.has(stored)) {
    return stored as LanguageCode
  }
  return enrolled[0] ?? null
}
