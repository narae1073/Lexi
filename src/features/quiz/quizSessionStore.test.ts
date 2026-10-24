import { beforeEach, describe, expect, it } from 'vitest'

import type { WordbookEntry } from '../wordbook/buildWordbook'
import type { QuizWord } from './quizSession'
import { useQuizSessionStore } from './quizSessionStore'

function word(lemma: string): QuizWord {
  return {
    lemma,
    surface: lemma,
    status: 'unsure',
    sentence: `${lemma} example`,
    documentTitle: 'Example',
  }
}

const entries = [] as WordbookEntry[]

beforeEach(() => {
  useQuizSessionStore.getState().reset()
})

describe('quiz session store', () => {
  it('retains an in-progress session outside the view lifecycle', () => {
    useQuizSessionStore.getState().selectLanguage('en')
    useQuizSessionStore.getState().selectSize(20)
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 20,
      entries,
      words: [word('alpha'), word('beta')],
    })
    useQuizSessionStore.getState().recordAnswer('unsure')
    useQuizSessionStore.getState().advance()

    // A remounted QuizView reads the store rather than recreating useState
    // values. This is the state it must resume with.
    const resumed = useQuizSessionStore.getState()
    expect(resumed.phase).toBe('session')
    expect(resumed.languageCode).toBe('en')
    expect(resumed.size).toBe(20)
    expect(resumed.words.map((item) => item.lemma)).toEqual(['alpha', 'beta'])
    expect(resumed.index).toBe(1)
    expect(resumed.answer).toBeNull()
    expect(resumed.results).toEqual(['unsure'])
  })

  it('retains the selected answer until the user advances', () => {
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 10,
      entries,
      words: [word('alpha'), word('beta')],
    })
    useQuizSessionStore.getState().recordAnswer('unknown')

    expect(useQuizSessionStore.getState()).toMatchObject({
      phase: 'session',
      index: 0,
      answer: 'unknown',
      results: ['unknown'],
    })
  })

  it('retains the summary phase and clears the session on the next setup', () => {
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 10,
      entries,
      words: [word('alpha')],
    })
    useQuizSessionStore.getState().recordAnswer('known')
    useQuizSessionStore.getState().advance()

    expect(useQuizSessionStore.getState().phase).toBe('summary')
    expect(useQuizSessionStore.getState().results).toEqual(['known'])

    useQuizSessionStore.getState().backToSetup()
    expect(useQuizSessionStore.getState().phase).toBe('setup')
    expect(useQuizSessionStore.getState().words).toEqual([])
    expect(useQuizSessionStore.getState().results).toEqual([])
    expect(useQuizSessionStore.getState().languageCode).toBe('en')
  })

  it('ends early with the answers given so far', () => {
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 10,
      entries,
      words: [word('alpha'), word('beta'), word('charlie')],
    })
    useQuizSessionStore.getState().recordAnswer('unsure')
    useQuizSessionStore.getState().finishEarly()

    expect(useQuizSessionStore.getState()).toMatchObject({
      phase: 'summary',
      endedEarly: true,
      results: ['unsure'],
      words: [expect.objectContaining({ lemma: 'alpha' }), expect.any(Object), expect.any(Object)],
    })
  })

  it('excludes the unanswered current question when ending early', () => {
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 10,
      entries,
      words: [word('alpha'), word('beta'), word('charlie')],
    })
    useQuizSessionStore.getState().recordAnswer('known')
    useQuizSessionStore.getState().advance()
    useQuizSessionStore.getState().finishEarly()

    expect(useQuizSessionStore.getState()).toMatchObject({
      phase: 'summary',
      endedEarly: true,
      index: 1,
      answer: null,
      results: ['known'],
    })
  })

  it('ends early with no answers as an empty partial summary', () => {
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 10,
      entries,
      words: [word('alpha'), word('beta')],
    })
    useQuizSessionStore.getState().finishEarly()

    expect(useQuizSessionStore.getState()).toMatchObject({
      phase: 'summary',
      endedEarly: true,
      results: [],
    })
  })

  it('does not mark a normally completed session as early', () => {
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 10,
      entries,
      words: [word('alpha')],
    })
    useQuizSessionStore.getState().recordAnswer('known')
    useQuizSessionStore.getState().advance()

    expect(useQuizSessionStore.getState()).toMatchObject({
      phase: 'summary',
      endedEarly: false,
      results: ['known'],
    })

    useQuizSessionStore.getState().backToSetup()
    expect(useQuizSessionStore.getState().endedEarly).toBe(false)
  })

  it('resets session and setup selections when the identity changes', () => {
    useQuizSessionStore.getState().selectLanguage('en')
    useQuizSessionStore.getState().selectSize(20)
    useQuizSessionStore.getState().startSession({
      languageCode: 'en',
      size: 20,
      entries,
      words: [word('alpha')],
    })
    useQuizSessionStore.getState().markPeeked()

    useQuizSessionStore.getState().reset()
    expect(useQuizSessionStore.getState()).toMatchObject({
      phase: 'setup',
      languageCode: null,
      size: null,
      words: [],
      index: 0,
      sessionEntries: [],
      answer: null,
      results: [],
      peeked: false,
    })
  })

  it('clears the count when choosing another language', () => {
    useQuizSessionStore.getState().selectSize(20)
    useQuizSessionStore.getState().selectLanguage('ko')
    expect(useQuizSessionStore.getState()).toMatchObject({
      languageCode: 'ko',
      size: null,
    })
  })
})
