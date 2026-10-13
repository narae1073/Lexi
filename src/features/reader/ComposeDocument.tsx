import { useState } from 'react'
import { Link } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useLanguagesStore } from '../../app/stores/languages'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { detectLanguage } from '../../lib/detectLanguage'
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

/**
 * 한 문서가 받아들이는 최대 글자 수.
 *
 * 붙여넣기에는 상한이 없었다. 하지만 두 곳이 먼저 지친다.
 * - 토크나이저는 본문을 문장·단위로 쪼개는 일을 화면이 멈춘 채 해 내므로,
 *   메가바이트짜리 글 하나가 탭을 얼린다.
 * - 동기화는 바뀐 문서를 한 요청에 실어 보낸다. 큰 문서가 프록시의 한도
 *   (~1MB) 에 닿으면 요청이 조용히 실패하고, 진도가 다른 기기로 안 간다.
 *
 * 50,000 자 (≈ 짧은 챕터 하나, 문서 하나에 ~150KB) 면 두 곳 모두 여유다.
 * 상한을 넘겼다고 타이핑을 막지 않는다 — 세어 보이고, 만들 때 이유를 말한다.
 */
const MAX_CHARS = 50_000

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

  /**
   * 붙여넣은 글의 언어를 알아내서 언어 버튼을 옮긴다 (개선사항.txt).
   *
   * 사람은 문서의 언어를 고르는 일을 잊는다 — 복사한 글은 이미 답을 알고 있다.
   * 되돌리기를 누르면 이번 작성 화면에서는 다시 옮기지 않는다 — 정정한 사람을
   * 또 옮기면 싸우는 것이다. 언어 버튼을 직접 누른 것은 화면을 정리하는 것뿐,
   * 옮기는 것은 되돌리기만 금한다 — 다음 붙여넣기는 언제나 새 신호다.
   *
   * 옮겨 가는 곳은 **배우는 언어 안에서만**이다. 문서는 배우는 언어로만 만들어지는
   * 것이 이 앱의 규칙이고(plan.txt 5줄), 버튼이 없는 언어로 옮기면 아무 버튼도
   * 눌리지 않은 채로 문서가 만들어진다. 배우지 않는 언어로 보이면 알려 주되,
   * 옮기는 것은 사람이 언어에 추가한 뒤의 몫이다.
   */
  const [autoDetect, setAutoDetect] = useState<{ from: LanguageCode; to: LanguageCode } | null>(null)
  /** 감지했지만 배우지 않는 언어 — 옮기지 않고 알려 준다 */
  const [detectedUnenrolled, setDetectedUnenrolled] = useState<LanguageCode | null>(null)
  /** undo · 정정 뒤에는 이번 작성 화면에서 감지가 다시 옮기지 않는다 */
  const [autoDetectOff, setAutoDetectOff] = useState(false)

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (autoDetectOff) return
    const pasted = event.clipboardData?.getData('text/plain') ?? ''
    const detected = detectLanguage(pasted)
    const target = detected.language
    if (!target || target === languageCode) return
    if (!enrolled.includes(target)) {
      setDetectedUnenrolled(target)
      return
    }
    setAutoDetect({ from: languageCode, to: target })
    setLanguageCode(target)
  }

  const undoAutoDetect = () => {
    if (!autoDetect) return
    setLanguageCode(autoDetect.from)
    setAutoDetect(null)
    setAutoDetectOff(true)
  }

  const trimmedLength = rawText.trim().length
  const tooShort = trimmedLength < MIN_CHARS
  const tooLong = trimmedLength > MAX_CHARS

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (tooShort) {
      setError(t('compose.tooShort', { count: trimmedLength }))
      return
    }
    if (tooLong) {
      setError(t('compose.tooLong', { count: trimmedLength, limit: MAX_CHARS }))
      return
    }
    setError(null)
    await create({ title, languageCode, rawText, fallbackTitle: t('compose.titlePlaceholder') })
    setTitle('')
    setRawText('')
    setAutoDetect(null)
    setDetectedUnenrolled(null)
    setAutoDetectOff(false)
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
              onClick={() => {
                // 직접 누르면 알림만 지운다 — 붙여넣기 전의 준비냐 정정이냐를 가리지 않고,
                // 다음 붙여넣기는 여전히 새 신호다. 되돌리기만 이번 화면에서 감지를 끈다.
                setLanguageCode(code)
                setAutoDetect(null)
                setDetectedUnenrolled(null)
              }}
              aria-pressed={code === languageCode}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                code === languageCode
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-line hover:border-line'
              }`}
            >
              {languageName(code)}
            </button>
          ))}
        </div>
      </label>

      {/* 자동으로 옮겼음을 밝힌다 — 조용히 옮기면 사기가 된다 */}
      {autoDetect && (
        <p role="status" className="text-ink-muted flex items-center gap-2 text-xs">
          <span>{t('compose.autoDetected', { language: languageName(autoDetect.to) })}</span>
          <button type="button" onClick={undoAutoDetect} className="text-accent underline">
            {t('compose.undo')}
          </button>
        </p>
      )}
      {detectedUnenrolled && (
        <p role="status" className="text-ink-muted flex items-center gap-2 text-xs">
          <span>{t('compose.suggestLanguage', { language: languageName(detectedUnenrolled) })}</span>
          <Link to="/languages" className="text-accent underline">
            {t('nav.languages')}
          </Link>
        </p>
      )}

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
          onPaste={handlePaste}
          rows={12}
          placeholder={t('compose.bodyPlaceholder')}
          className="resize-y rounded-lg border border-line px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:border-accent"
        />
        <span
          className={`self-end text-xs ${tooLong ? 'text-status-unknown' : 'text-ink-muted'}`}
        >
          {t('compose.counter', {
            count: trimmedLength,
            limit: MAX_CHARS,
            language: languageName(languageCode),
          })}
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