import { useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { DictionaryPanel } from '../dictionary/DictionaryPanel'
import { STATUS_GLYPH, WORD_STATUSES, type LanguageCode, type Segment, type WordStatus } from '../../types'
import { Popover } from './Popover'

/** plan.txt 3줄: 단어 박스. 사전 결과를 담기 때문에 기본 폭보다 넓다 */
const WORD_POPOVER_WIDTH = 300

/**
 * 단어 위에 뜨는 작은 박스 (plan.txt 3줄).
 * 상태 버튼 ○ ◐ ● 과 사전 버튼을 담는다.
 */
export function WordPopover({
  segment,
  lemma,
  languageCode,
  anchor,
  onTranslateSentence,
  onClose,
}: {
  segment: Extract<Segment, { type: 'word' }>
  /** 문서 문맥으로 정규화한 대표 형태. 상태·사전 조회는 전부 이 값을 쓴다. */
  lemma: string
  languageCode: LanguageCode
  anchor: HTMLElement | null
  /** 이 단어가 속한 문장을 바로 번역한다 — 드래그 없이 하는 길 */
  onTranslateSentence?: () => void
  onClose: () => void
}) {
  const t = useTranslation()
  const current = useWordStatesStore((s) => s.byKey[`${languageCode}::${lemma}`]?.status)
  const setStatus = useWordStatesStore((s) => s.setStatus)
  const [showDictionary, setShowDictionary] = useState(false)

  return (
    <Popover
      anchor={anchor}
      anchorKey={`${segment.start}:${showDictionary}`}
      onClose={onClose}
      width={WORD_POPOVER_WIDTH}
    >
      <p className="truncate pb-1 text-sm font-semibold" title={segment.text}>
        {segment.text}
      </p>

      <div className="grid grid-cols-3 gap-1" role="group" aria-label={t('status.group')}>
        {WORD_STATUSES.map((status: WordStatus) => {
          const active = current === status
          return (
            <button
              key={status}
              type="button"
              onClick={() => setStatus(languageCode, lemma, status, segment.text)}
              aria-pressed={active}
              aria-label={t(`status.${status}`)}
              title={t(`status.${status}`)}
              className={`pointer-events-auto flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 text-xs transition ${
                active
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-line hover:border-accent'
              }`}
            >
              <span className="text-sm leading-none">{STATUS_GLYPH[status]}</span>
              <span className="leading-none">{t(`status.short${CAP[status]}`)}</span>
            </button>
          )
        })}
      </div>

      {showDictionary ? (
        <div className="mt-1 border-line border-t pt-1.5">
          <DictionaryPanel
            languageCode={languageCode}
            lemma={lemma}
            surface={segment.text}
          />
          <button
            type="button"
            onClick={() => setShowDictionary(false)}
            className="pointer-events-auto text-ink-muted hover:text-ink mt-1.5 text-[10px] underline"
          >
            {t('dictionary.hide')}
          </button>
        </div>
      ) : (
        <div className="mt-1 flex gap-1">
          <button
            type="button"
            onClick={() => setShowDictionary(true)}
            className="pointer-events-auto border-line text-ink-muted hover:text-ink hover:border-accent flex-1 rounded-lg border px-2 py-1.5 text-xs transition"
          >
            {t('dictionary.button')}
          </button>
          {onTranslateSentence && (
            <button
              type="button"
              onClick={onTranslateSentence}
              // 드래그로 고르는 길이 손에 익지 않으면 이 버튼이 대신한다 (plan.txt 6줄)
              className="pointer-events-auto border-line text-ink-muted hover:text-ink hover:border-accent flex-1 rounded-lg border px-2 py-1.5 text-xs transition"
            >
              {t('sentence.button')}
            </button>
          )}
        </div>
      )}
    </Popover>
  )
}

const CAP = { known: 'Known', unsure: 'Unsure', unknown: 'Unknown' } as const