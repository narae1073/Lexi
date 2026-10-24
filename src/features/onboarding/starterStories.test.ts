import { describe, expect, it } from 'vitest'

import { SUPPORTED_LANGUAGE_CODES } from '../../lib/languages'
import { STARTER_STORIES } from './starterStories'

describe('starter stories', () => {
  it('covers every supported language', () => {
    expect(Object.keys(STARTER_STORIES).sort()).toEqual([...SUPPORTED_LANGUAGE_CODES].sort())
  })

  it('gives every language a greeting, title, snippet, and readable body', () => {
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      const story = STARTER_STORIES[code]
      expect(story.greeting.trim().length, `${code} greeting`).toBeGreaterThan(0)
      expect(story.title.trim().length, `${code} title`).toBeGreaterThan(0)
      expect(story.body.trim().length, `${code} body`).toBeGreaterThan(50)
      expect(story.body.length, `${code} length`).toBeLessThanOrEqual(1000)
      expect(story.body.startsWith(story.snippet), `${code} snippet`).toBe(true)
    }
  })
})
