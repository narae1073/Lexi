import { useEffect, useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { DEFINITION_LANGUAGE } from '../../lib/languages'
import { TranslateError, useTranslateStore } from '../../lib/api/translate'
import type { LanguageCode, Segment } from '../../types'
import { ExampleSentence } from '../reader/ExampleSentence'

type WordSegment = Extract<Segment, { type: 'word' }>

type Phase = 'loading' | 'done' | 'error'

type Outcome = {
  /** 어느 요청의 결과인지 — 요청이 바뀌면 이전 결과는 버린다 */
  requestKey: string
  phase: Phase
  translatedText?: string
  offline?: boolean
  identity?: boolean
  status?: number
}

/**
 * 답한 뒤 보여 주는 문맥 — 예문과 그 번역.
 *
 * 예문의 단어는 눌러서 사전을 볼 수 있다 (단어장과 같은 것을 쓴다). 번역은 읽기
 * 화면의 문장 번역과 같은 규칙을 따른다 — 배울 언어가 무엇이든 뜻과 번역은 영어로
 * (PLAN.md §1). 그래서 영어 글은 "이미 영어라 번역할 것이 없다" 가 된다.
 *
 * 답을 고른 뒤에만 보이므로, 번역을 미리 불러 두지 않고 그때 처음 요청한다.
 */
export function QuizSentence({
  sentence,
  documentTitle,
  languageCode,
  onWordClick,
}: {
  sentence: string
  /** 예문이 나온 문서 제목 — 비어 있으면 밝히지 않는다 */
  documentTitle: string
  languageCode: LanguageCode
  onWordClick: (segment: WordSegment, lemma: string, anchor: HTMLElement) => void
}) {
  const t = useTranslation()
  const translate = useTranslateStore((s) => s.translate)

  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const requestKey = `${languageCode}>${DEFINITION_LANGUAGE}>${attempt}>${sentence}`

  useEffect(() => {
    if (!sentence) return
    let cancelled = false

    translate(sentence, languageCode, DEFINITION_LANGUAGE)
      .then((r) => {
        if (cancelled) return
        setOutcome({
          requestKey,
          phase: 'done',
          translatedText: r.translatedText,
          identity: r.identity,
          offline: r.offline,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setOutcome({
          requestKey,
          phase: 'error',
          status: error instanceof TranslateError ? error.status : undefined,
        })
      })

    return () => {
      cancelled = true
    }
  }, [requestKey, sentence, languageCode, translate])

  // effect 안에서 동기 setState 를 하지 않는다 — 요청 키가 다르면 아직 결과가 없는 상태로 본다
  const current = outcome?.requestKey === requestKey ? outcome : null

  return (
    <div data-quiz-sentence className="border-line mt-6 rounded-xl border px-4 py-3">
      <p className="text-ink text-sm leading-relaxed">
        <ExampleSentence
          sentence={sentence}
          languageCode={languageCode}
          onWordClick={onWordClick}
        />
      </p>

      {!current && <p className="text-ink-muted mt-1.5 text-xs">{t('sentence.translating')}</p>}

      {current?.phase === 'error' && (
        <div className="mt-1.5 flex items-start justify-between gap-2">
          <p className="text-status-unknown flex-1 text-xs">
            {current.status
              ? t('sentence.failedStatus', { status: current.status })
              : t('sentence.failed')}
          </p>
          <button
            type="button"
            data-quiz-sentence-retry
            onClick={() => setAttempt((n) => n + 1)}
            className="border-line text-ink-muted hover:text-ink shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
          >
            {t('sentence.retry')}
          </button>
        </div>
      )}

      {current?.phase === 'done' && current.identity && (
        <p className="text-ink-muted mt-1.5 text-xs italic">{t('sentence.identity')}</p>
      )}

      {current?.phase === 'done' && !current.identity && (
        <>
          <p className="mt-1.5 text-sm leading-relaxed">{current.translatedText}</p>
          {/* 서버를 못 봤으면 최신이라고 착각하지 않도록 밝힌다 */}
          {current.offline && (
            <p className="text-status-unsure mt-0.5 text-[10px]">{t('sentence.offline')}</p>
          )}
        </>
      )}

      {/* 문맥이 어디서 온 것인지 밝힌다 — 단어장이 문서 제목을 보여 주는 것과 같다 */}
      {documentTitle && (
        <p data-quiz-sentence-source className="text-ink-muted mt-2 text-[11px]">
          {t('quiz.sentenceFrom', { title: documentTitle })}
        </p>
      )}
    </div>
  )
}
