import { useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { DictionaryPanel } from '../dictionary/DictionaryPanel'
import { StarPalette } from './StarPalette'
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
  startWithDictionary = false,
  onClose,
}: {
  segment: Extract<Segment, { type: 'word' }>
  /** 문서 문맥으로 정규화한 대표 형태. 상태·사전 조회는 전부 이 값을 쓴다. */
  lemma: string
  languageCode: LanguageCode
  anchor: HTMLElement | null
  /** 이 단어가 속한 문장을 바로 번역한다 — 드래그 없이 하는 길 */
  onTranslateSentence?: () => void
  /**
   * 사전부터 보여준다.
   *
   * 단어장에서 들어오면 '사전 보기' 를 한 번 더 누르게 하지 않는다 — 같은 박스를
   * 사전이 열린 상태로 보여준다. 문서에서는 기존처럼 닫힌 상태로 시작한다.
   */
  startWithDictionary?: boolean
  onClose: () => void
}) {
  const t = useTranslation()
  const current = useWordStatesStore((s) => s.byKey[`${languageCode}::${lemma}`]?.status)
  const favorite = useWordStatesStore((s) => s.byKey[`${languageCode}::${lemma}`]?.favorite ?? false)
  const starColor = useWordStatesStore((s) => s.byKey[`${languageCode}::${lemma}`]?.starColor)
  const setStatus = useWordStatesStore((s) => s.setStatus)
  const clearStatus = useWordStatesStore((s) => s.clearStatus)
  const toggleFavorite = useWordStatesStore((s) => s.toggleFavorite)
  const setStarColor = useWordStatesStore((s) => s.setStarColor)
  const [showDictionary, setShowDictionary] = useState(startWithDictionary)
  const [showPalette, setShowPalette] = useState(false)

  return (
    <Popover
      anchor={anchor}
      anchorKey={`${segment.start}:${showDictionary}`}
      onClose={onClose}
      width={WORD_POPOVER_WIDTH}
    >
      <div className="flex items-center gap-1 pb-1">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold" title={segment.text}>
          {segment.text}
        </p>
        {/*
          즐겨찾기 ☆/★ — 제목 오른쪽.
          상태(○◐●)와 독립이다. 아무리 외워도 외워지지 않는 단어, 그냥 마음에 드는
          단어를 따로 모아 두는 자리다. 본문에 별을 그릴지는 아직 정하지 않았다.
        */}
        <button
          type="button"
          onClick={() => toggleFavorite(languageCode, lemma, segment.text)}
          aria-pressed={favorite}
          aria-label={favorite ? t('favorite.remove') : t('favorite.add')}
          title={favorite ? t('favorite.remove') : t('favorite.add')}
          className={`pointer-events-auto shrink-0 rounded-lg px-1.5 py-0.5 text-base leading-none transition ${
            favorite ? 'text-accent' : 'text-ink-muted hover:text-ink'
          }`}
        >
          {favorite ? '★' : '☆'}
        </button>
        {/*
          별 색 고르기 — 별이 있을 때만 보인다. 작은 색창이 아래에 펼쳐진다.
        */}
        {favorite && (
          <button
            type="button"
            onClick={() => setShowPalette((v) => !v)}
            aria-expanded={showPalette}
            aria-label={t('favorite.pickColor')}
            title={t('favorite.pickColor')}
            className="pointer-events-auto flex shrink-0 items-center rounded-lg px-1.5 py-1 transition hover:opacity-80"
          >
            <span
              aria-hidden
              className="border-line block h-3 w-3 rounded-full border"
              style={{ backgroundColor: starColor }}
            />
          </button>
        )}
      </div>

      {favorite && showPalette && (
        <StarPalette
          current={starColor}
          onPick={(hex) => {
            setStarColor(languageCode, lemma, hex, segment.text)
            setShowPalette(false)
          }}
        />
      )}

      <div className="grid grid-cols-3 gap-1" role="group" aria-label={t('status.group')}>
        {WORD_STATUSES.map((status: WordStatus) => {
          const active = current === status
          return (
            <button
              key={status}
              type="button"
              // 켜진 버튼을 한 번 더 누르면 표시를 없앤다 — 미표시로 돌아가는 길이다
              onClick={() =>
                active
                  ? clearStatus(languageCode, lemma)
                  : setStatus(languageCode, lemma, status, segment.text)
              }
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