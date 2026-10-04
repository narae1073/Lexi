import { useEffect, useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { TranslateError, useTranslateStore } from '../../lib/api/translate'
import type { Sentence } from '../../types'
import { Popover } from './Popover'

/** plan.txt 6줄: 단어 박스보다 조금 더 커야 한다 */
export const SENTENCE_POPOVER_WIDTH = 360

type Phase = 'loading' | 'done' | 'error'

type Outcome = {
  /** 이 결과가 어느 요청 것인지 — attempt 로 요청이 바뀌면 이전 결과는 무시한다 */
  requestKey: string
  phase: Phase
  translatedText?: string
  /** 서버에 닿지 못해 이 기기에 저장돼 있던 결과인지 */
  offline?: boolean
  identity?: boolean
  status?: number
}

/**
 * 문장 위에 뜨는 큰 박스 (plan.txt 6줄).
 * 문장을 고르면 그 자리에서 곧바로 번역이 나타난다.
 */
export function SentencePopover({
  sentences,
  languageCode,
  targetLanguage,
  anchor,
  onClose,
}: {
  sentences: Sentence[]
  languageCode: string
  /** 뜻과 마찬가지로 번역도 영어로 (PLAN.md §1) */
  targetLanguage: string
  anchor: HTMLElement | null
  onClose: () => void
}) {
  const t = useTranslation()
  const translate = useTranslateStore((s) => s.translate)

  const source = sentences
    .map((s) => s.text)
    .join('')
    .trim()

  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const requestKey = `${languageCode}>${targetLanguage}>${attempt}>${source}`

  useEffect(() => {
    if (!source) return
    let cancelled = false

    translate(source, languageCode, targetLanguage)
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
  }, [requestKey, source, languageCode, targetLanguage, translate])

  // effect 안에서 동기 setState 를 하지 않는다 — 요청 키가 다르면 아직 결과가 없는 상태로 본다
  const current = outcome?.requestKey === requestKey ? outcome : null

  return (
    <Popover anchor={anchor} anchorKey={source} onClose={onClose} width={SENTENCE_POPOVER_WIDTH}>
      <div className="flex flex-col gap-2">
        <p className="text-ink-muted border-b border-line pb-2 text-xs leading-relaxed">
          {source}
        </p>

        {!current && <p className="text-ink-muted py-1 text-sm">{t('sentence.translating')}</p>}

        {current?.phase === 'error' && (
          <div className="flex items-start justify-between gap-2">
            <p className="text-status-unknown flex-1 py-1 text-sm">
              {current.status ? t('sentence.failedStatus', { status: current.status }) : t('sentence.failed')}
            </p>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="pointer-events-auto shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-muted"
            >
              {t('sentence.retry')}
            </button>
          </div>
        )}

        {current?.phase === 'done' && current.identity && (
          <p className="text-ink-muted py-1 text-sm italic">{t('sentence.identity')}</p>
        )}

        {current?.phase === 'done' && !current.identity && (
          <>
            <p className="py-1 text-sm leading-relaxed">{current.translatedText}</p>
            {/* 서버를 못 봤으면 최신이라고 착각하지 않도록 밝힌다 */}
            {current.offline && <p className="text-status-unsure text-[10px]">{t('sentence.offline')}</p>}
          </>
        )}
      </div>
    </Popover>
  )
}