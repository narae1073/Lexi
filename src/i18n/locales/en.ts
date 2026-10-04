/**
 * 번역 사전의 기준이 되는 언어 (앱 기본 언어 — plan.txt 1).
 * 다른 사전은 이 파일의 구조를 그대로 따라야 한다 (컴파일 타임에 검사된다).
 */
export const en = {
  appName: 'Lexi',

  nav: {
    languages: 'Languages',
    compose: 'Add text',
    settings: 'Settings',
    wordbook: 'Wordbook',
  },

  onboarding: {
    title: 'Choose what you want to learn',
    hint: 'Pick the languages you are studying. You can add more later.',
    selectAtLeastOne: 'Choose at least one language',
    done: 'Done',
  },

  compose: {
    title: 'Paste a text',
    language: 'Language',
    titleField: 'Title (optional)',
    titlePlaceholder: 'Untitled',
    body: 'Text',
    bodyPlaceholder: 'Paste something written in the language you are learning.',
    counter: '{count} chars · {language}',
    tooShort: 'Enter at least {min} characters (currently {count}).',
    create: 'Create document',
    pickLanguageFirst: 'Choose a language first.',
  },

  list: {
    loading: 'Loading…',
    empty: 'No documents yet.',
    meta: '{language} · {count} chars · {date}',
  },

  reader: {
    stats: '{words} words · {sentences} sentences',
    toWordbook: 'Words in this document',
  },

  status: {
    group: 'Word status',
    known: 'Know it',
    unsure: 'Unsure',
    unknown: 'Do not know',
    shortKnown: 'Know',
    shortUnsure: 'Unsure',
    shortUnknown: 'New',
  },

  wordbook: {
    title: 'Wordbook',
    pickLanguage: 'Choose a language to see your words.',
    summary: '{count} words',
    scoped: 'From “{title}”',
    search: 'Search words',
    legend: 'Tap a status to mark the word.',
    noContext: 'No context recorded.',
    group: {
      unmarked: 'Not marked',
      known: 'Know it',
      unsure: 'Unsure',
      unknown: 'Do not know',
    },
    empty: {
      unmarked: 'No unmarked words. Open a document to collect words.',
      known: 'Nothing marked as known yet.',
      unsure: 'Nothing marked as unsure yet.',
      unknown: 'Nothing marked as unknown yet.',
    },
  },

  dictionary: {
    button: 'Dictionary',
    loading: 'Looking up…',
    notFound: 'No entry for “{word}”.',
    failed: 'Could not reach the dictionary.',
    failedStatus: 'Dictionary error ({status}).',
    source: 'Wiktionary · {license}',
    hide: 'Hide',
    baseForm: 'Base form',
  },

  sentence: {
    translating: 'Translating…',
    retry: 'Try again',
    identity: 'This text is already in English, so there is nothing to translate.',
    failed: 'Translation failed. Please try again.',
    failedStatus: 'Translation service error ({status}).',
  },

  settings: {
    title: 'Settings',
    unmarkedDim: 'Unmarked word shade',
    unmarkedDimHint: 'Words you have not marked yet are drawn {value}% lighter. Applies to every theme.',
    dimStrong: 'Strong',
    dimFaint: 'Faint',
    reset: 'Reset',
    appLanguage: 'App language',
    theme: 'Theme',
    system: 'System',
    close: 'Close',
  },

  /** 언어 고유명은 자기 언어로 표기한다 (nativeLabel) */
  languageNames: {
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    zh: 'Chinese (Simplified)',
  },
} as const

/**
 * 문자열 리터럴을 string 으로 넓힌다.
 * en 을 `as const` 로 선언해도 다른 사전은 각자의 언어로 값을 담을 수 있어야 한다.
 */
type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> }

/** 다른 사전은 en 과 동일한 모양이어야 한다 — 누락·오타는 컴파일 에러가 된다 */
export type Dictionary = Widen<typeof en>