import { describe, expect, it } from 'vitest'

import type { LanguageCode } from '../../types'
import { wordbookLanguageOrDefault } from './wordbookLanguage'

const enrolled: LanguageCode[] = ['en', 'fr', 'de']

describe('wordbookLanguageOrDefault', () => {
  it('prefers a valid requested language over the stored preference', () => {
    expect(wordbookLanguageOrDefault('de', 'fr', enrolled)).toBe('de')
  })

  it('uses the stored language when the URL has no valid language', () => {
    expect(wordbookLanguageOrDefault(null, 'de', enrolled)).toBe('de')
    expect(wordbookLanguageOrDefault('ja', 'de', enrolled)).toBe('de')
  })

  it('ignores a stored language that is no longer enrolled', () => {
    expect(wordbookLanguageOrDefault(null, 'ja', enrolled)).toBe('en')
  })

  it('falls back to the first enrolled language', () => {
    expect(wordbookLanguageOrDefault(undefined, undefined, ['fr', 'de'])).toBe('fr')
  })

  it('returns null when no languages are enrolled', () => {
    expect(wordbookLanguageOrDefault('en', 'fr', [])).toBeNull()
  })
})
