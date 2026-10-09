import { useState } from 'react'

import { useDocumentsStore } from '../../app/stores/documents'
import { useLanguagesStore } from '../../app/stores/languages'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { getLanguage } from '../../lib/languages'
import type { LanguageCode } from '../../types'

/**
 * 비어 있지 않으면 된다.
 *
 * 예전에는 20 자를 요구했는데, 언어 학습에서는 짧은 문장 하나가 흔하다.
 * 그门槛을 넘어야 "만들기" 버튼이 켜지는 구조였는데, 버튼이 그냥 꺼져
 * 보이는 것뿐 이유를 알려주지 않았다. 특히 휴대전화에서 30% 투명도는
 * 손대지 않은 화면처럼 보여서 "버튼이 안 먹는다" 고 오해하기 쉽다.
 * 이제 버튼은 언제나 눌리고, 비었을 때 이유를 말해준다.
 */
const MIN_CHARS = 1

/** 텍스트를 입력받아 문서를 만든다 (plan.txt 2줄). */
export function ComposeDocument() {
  const t = useTranslation()
  const languageName = useLanguageName()
  const enrolled = useLanguagesStore((s) => s.enrolled)
  const create = useDocumentsStore((s) => s.create)

  const [languageCode, setLanguageCode] = useState<LanguageCode>(enrolled[0] ?? 'en')
  const [title, setTitle] = useState('')
  const [rawText, setRawText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const trimmedLength = rawText.trim().length
  const tooShort = trimmedLength < MIN_CHARS

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (tooShort) {
      setError(t('compose.tooShort', { count: trimmedLength }))
      return
    }
    setError(null)
    await create({ title, languageCode, rawText, fallbackTitle: t('compose.titlePlaceholder') })
    setTitle('')
    setRawText('')
  }

  if (enrolled.length === 0) {
    return <p className="p-8 text-sm text-ink-muted">{t('compose.pickLanguageFirst')}</p>
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-8">
      <h1 className="text-lg font-semibold">{t('compose.title')}</h1>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('compose.language')}</span>
        <div className="flex flex-wrap gap-2">
          {enrolled.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLanguageCode(code)}
              aria-pressed={code === languageCode}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                code === languageCode
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-line hover:border-line'
              }`}
            >
              <span aria-hidden>{getLanguage(code)?.flag}</span> {languageName(code)}
            </button>
          ))}
        </div>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('compose.titleField')}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('compose.titlePlaceholder')}
          className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('compose.body')}</span>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={12}
          placeholder={t('compose.bodyPlaceholder')}
          className="resize-y rounded-lg border border-line px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:border-accent"
        />
        <span className="text-ink-muted self-end text-xs">
          {t('compose.counter', { count: trimmedLength, language: languageName(languageCode) })}
        </span>
      </label>

      {error && (
        <p role="alert" className="text-status-unknown text-sm">
          {error}
        </p>
      )}

      {/*
        막지 않는다. 꺼진 버튼은 이유를 말해줄 수 없고, 휴대전화에서는
        손대지 않은 화면처럼 보여서 "버튼이 안 먹는다" 고 오해하게 만든다.
        눌렀을 때 이유를 말하는 편이 낫다.
      */}
      <button
        type="submit"
        aria-disabled={tooShort}
        className={`rounded-lg px-4 py-2.5 text-sm font-medium ${
          tooShort ? 'bg-line text-ink-muted' : 'bg-accent text-accent-ink'
        }`}
      >
        {t('compose.create')}
      </button>
    </form>
  )
}