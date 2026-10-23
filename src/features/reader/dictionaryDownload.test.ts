import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { en } from '../../i18n/locales/en'
import { ko } from '../../i18n/locales/ko'
import { useSettingsStore } from '../../app/stores/settings'
import {
  DICTIONARY_DOWNLOADS,
  dictionaryDownloadResult,
  dictionaryPromptLanguage,
  dictionaryPromptMessage,
  loadLinderaWith,
  shouldAutoDownload,
  type DictionaryDownloadEnvironment,
  type LinderaLoadDeps,
  type LinderaTokenizer,
} from './lindera'
import { segmentJapanese } from './japanese'

/**
 * 사전 내려받기 회귀 테스트.
 *
 * 사전 zip 은 10.5 MB / 7.25 MB 다 — 앱이 말없이 받으면 안 된다. 특히
 * `saveData` 나 느린 연결에서는 자동으로 받지 않고, 사용자가 정확한 크기를
 * 보고 허락해야 받는다. 거절하면 zip 을 받지 않고 기존 Intl 분절로 폴백한다.
 */

const tokenizer: LinderaTokenizer = { tokenize: () => [] }

function deps(overrides: Partial<LinderaLoadDeps> = {}): LinderaLoadDeps {
  return {
    hasDictionary: vi.fn(async () => false),
    downloadDictionary: vi.fn(async () => {}),
    loadTokenizer: vi.fn(async () => tokenizer),
    ...overrides,
  }
}

const askEnv: DictionaryDownloadEnvironment = {
  autoDownload: false,
  saveData: false,
  effectiveType: '4g',
  online: true,
}

describe('shouldAutoDownload', () => {
  it('사용자가 허락했고 연결이 괜찮을 때만 자동으로 받는다', () => {
    expect(shouldAutoDownload({ ...askEnv, autoDownload: true })).toBe(true)
  })

  it('saveData 는 자동 다운로드를 막는다', () => {
    expect(shouldAutoDownload({ ...askEnv, autoDownload: true, saveData: true })).toBe(false)
  })

  it('2G 급 연결에서는 자동으로 받지 않는다', () => {
    expect(
      shouldAutoDownload({ ...askEnv, autoDownload: true, effectiveType: '2g' }),
    ).toBe(false)
    expect(
      shouldAutoDownload({ ...askEnv, autoDownload: true, effectiveType: 'slow-2g' }),
    ).toBe(false)
    expect(
      shouldAutoDownload({ ...askEnv, autoDownload: true, effectiveType: '3g' }),
    ).toBe(true)
  })

  it('오프라인이면 자동으로 받지 않는다', () => {
    expect(shouldAutoDownload({ ...askEnv, autoDownload: true, online: false })).toBe(false)
  })

  it('셀룰러로 보고되면 자동으로 받지 않는다', () => {
    expect(
      shouldAutoDownload({
        ...askEnv,
        autoDownload: true,
        connectionType: 'cellular',
      }),
    ).toBe(false)
  })
})

describe('loadLinderaWith', () => {
  it('허락하지 않으면 zip 을 받지 않고 null 로 폴백한다', async () => {
    const d = deps()
    const confirm = vi.fn(async () => false)

    const result = await loadLinderaWith('ja', d, askEnv, confirm)

    expect(confirm).toHaveBeenCalledWith('ja')
    expect(d.downloadDictionary).not.toHaveBeenCalled()
    expect(result).toBeNull()
    // 토크나이저가 없으니 호출부는 기존 Intl 분절을 그대로 쓴다
    expect(segmentJapanese('食べた')).toBeNull()
  })

  it('saveData 가 켜져 있으면 자동으로 받지 않고 먼저 묻는다', async () => {
    const events: string[] = []
    const d = deps({
      downloadDictionary: vi.fn(async () => {
        events.push('download')
      }),
    })
    const env: DictionaryDownloadEnvironment = {
      ...askEnv,
      autoDownload: true,
      saveData: true,
    }

    const result = await loadLinderaWith('ja', d, env, async () => {
      events.push('confirm')
      return true
    })

    expect(events).toEqual(['confirm', 'download'])
    expect(result).toBe(tokenizer)
  })

  it('자동 다운로드가 허락되면 묻지 않고 받는다', async () => {
    const d = deps()
    const confirm = vi.fn(async () => false)

    const result = await loadLinderaWith(
      'ja',
      d,
      { ...askEnv, autoDownload: true },
      confirm,
    )

    expect(confirm).not.toHaveBeenCalled()
    expect(d.downloadDictionary).toHaveBeenCalledWith(
      DICTIONARY_DOWNLOADS.ja.url,
      DICTIONARY_DOWNLOADS.ja.name,
    )
    expect(result).toBe(tokenizer)
  })

  it('이미 OPFS 에 있으면 묻지도 받지도 않고 바로 연다', async () => {
    const d = deps({ hasDictionary: vi.fn(async () => true) })
    const confirm = vi.fn(async () => false)

    const result = await loadLinderaWith('zh', d, askEnv, confirm)

    expect(confirm).not.toHaveBeenCalled()
    expect(d.downloadDictionary).not.toHaveBeenCalled()
    expect(result).toBe(tokenizer)
  })

  it('forcePrompt 는 자동 다운로드가 켜져 있어도 반드시 묻는다', async () => {
    const d = deps()
    const confirm = vi.fn(async () => false)

    const result = await loadLinderaWith(
      'ja',
      d,
      { ...askEnv, autoDownload: true },
      confirm,
      { forcePrompt: true },
    )

    expect(confirm).toHaveBeenCalledWith('ja')
    expect(d.downloadDictionary).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('forcePrompt 에서 허락하면 자동 설정과 무관하게 받는다', async () => {
    const d = deps()
    const result = await loadLinderaWith(
      'ja',
      d,
      { ...askEnv, autoDownload: true },
      async () => true,
      { forcePrompt: true },
    )

    expect(d.downloadDictionary).toHaveBeenCalledTimes(1)
    expect(result).toBe(tokenizer)
  })
})

describe('사전 크기와 안내 문구', () => {
  it('정확한 zip 크기를 보여 준다', () => {
    expect(DICTIONARY_DOWNLOADS.ja.label).toBe('10.5 MB')
    expect(DICTIONARY_DOWNLOADS.zh.label).toBe('7.25 MB')
  })

  it('확인 문구에 사전 이름과 크기가 들어간다', () => {
    expect(dictionaryPromptMessage('ja', 'en')).toContain('Japanese')
    expect(dictionaryPromptMessage('ja', 'en')).toContain('10.5 MB')
    expect(dictionaryPromptMessage('zh', 'en')).toContain('Chinese')
    expect(dictionaryPromptMessage('zh', 'en')).toContain('7.25 MB')
    expect(dictionaryPromptMessage('ja', 'ko')).toContain('10.5 MB')
  })
})

describe('안내 언어와 다운로드 결과', () => {
  it('document.lang 이 아니라 저장된 앱 언어 설정을 따른다', () => {
    const previous = useSettingsStore.getState().appLanguage
    try {
      useSettingsStore.setState({ appLanguage: 'ko' })
      expect(dictionaryPromptLanguage()).toBe('ko')
      expect(dictionaryPromptMessage('ja', dictionaryPromptLanguage())).toContain('사전')

      useSettingsStore.setState({ appLanguage: 'en' })
      expect(dictionaryPromptLanguage()).toBe('en')
      expect(dictionaryPromptMessage('ja', dictionaryPromptLanguage())).toContain('dictionary')
    } finally {
      useSettingsStore.setState({ appLanguage: previous })
    }
  })

  it('설정 화면이 취소와 실패를 구분할 수 있다', () => {
    expect(dictionaryDownloadResult(true, false)).toBe('downloaded')
    expect(dictionaryDownloadResult(false, true)).toBe('declined')
    expect(dictionaryDownloadResult(false, false)).toBe('failed')
  })
})

describe('PWA precache', () => {
  const config = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')

  it('Lindera WASM 을 precache 대상에 넣는다', () => {
    const globs = config.split('\n').find((line) => line.includes('globPatterns')) ?? ''
    expect(globs).toContain('wasm')
    // 사전 zip 은 여전히 요청 시에만 받는다 — precache 에 넣으면 설치가 17 MB 커진다
    expect(globs).not.toContain('zip')
  })

  it('WASM(1.89 MB)이 기본 2 MB 상한에 걸리지 않게 올려 둔다', () => {
    const max = config
      .split('\n')
      .find((line) => line.includes('maximumFileSizeToCacheInBytes'))
    expect(max).toBeDefined()
    expect(max).toContain('3 * 1024 * 1024')
  })
})

describe('사전 키 parity', () => {
  it('en 과 ko 가 같은 키를 가진다', () => {
    const flatten = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? flatten(value, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      )

    const enKeys = flatten(en).sort()
    expect(flatten(ko).sort()).toEqual(enKeys)
  })

  it('사전 안내 문구가 두 언어에 모두 있다', () => {
    const flatten = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? flatten(value, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      )

    const required = [
      'dictionary.downloadPrompt',
      'settings.dictionaryTitle',
      'settings.dictionaryHint',
      'settings.dictionaryAutoDownload',
      'settings.dictionaryAutoDownloadHint',
      'settings.dictionaryDownload',
      'settings.dictionaryDownloaded',
      'settings.dictionaryDeclined',
      'settings.dictionaryFailed',
      'settings.storageResponseCache',
    ]

    for (const key of required) {
      expect(flatten(en)).toContain(key)
      expect(flatten(ko)).toContain(key)
    }
  })
})
