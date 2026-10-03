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
  languageCode,
  anchor,
  onClose,
}: {
  segment: Extract<Segment, { type: 'word' }>
  languageCode: LanguageCode
  anchor: HTMLElement | null
  onClose: () => void
}) {
  const t = useTranslation()
  const current = useWordStatesStore((s) => s.byKey[`${languageCode}::${segment.lemma}`]?.status)
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
              onClick={() => setStatus(languageCode, segment.lemma, status, segment.text)}
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
            lemma={segment.lemma}
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
        <button
          type="button"
          onClick={() => setShowDictionary(true)}
          className="pointer-events-auto border-line text-ink-muted hover:text-ink hover:border-accent mt-1 w-full rounded-lg border px-2 py-1.5 text-xs transition"
        >
          {t('dictionary.button')}
        </button>
      )}
    </Popover>
  )
}

const CAP = { known: 'Known', unsure: 'Unsure', unknown: 'Unknown' } as const