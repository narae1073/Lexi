import { useState } from 'react'

import { STAR_COLOR_DEFAULT, useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import {
  WORD_STATUSES,
  type LanguageCode,
  type Segment,
  type WordStatus,
} from '../../types'
import { ExampleSentence } from '../reader/ExampleSentence'
import { starSwatchName } from '../reader/favoriteStar'
import { useFavoriteConfirmation } from '../reader/useFavoriteConfirmation'
import { WordPopover } from '../reader/WordPopover'
import type { WordbookEntry } from './buildWordbook'

type WordSegment = Extract<Segment, { type: 'word' }>

type DictionaryTarget = {
  segment: WordSegment
  lemma: string
  anchor: HTMLElement
}

/**
 * 단어 한 개.
 * 표기(또는 여러 표기) · 예문 · 출처 문서 · 상태 변경을 보여준다.
 */
export function WordbookItem({
  entry,
  languageCode,
}: {
  entry: WordbookEntry
  languageCode: LanguageCode
}) {
  const t = useTranslation()
  const setStatus = useWordStatesStore((s) => s.setStatus)
  const { requestToggle: requestFavoriteToggle, confirmation: favoriteConfirmation } =
    useFavoriteConfirmation()
  const [dictionaryTarget, setDictionaryTarget] = useState<DictionaryTarget | null>(null)

  const starColor = entry.starColor ?? STAR_COLOR_DEFAULT
  const starAngle = entry.starAngle ?? 0
  const swatchName = starSwatchName(starColor)
  const colorLabel = swatchName ? t(`favorite.colors.${swatchName}`) : null
  const favoriteLabel = entry.favorite
    ? `${t('favorite.remove')}${colorLabel ? ` · ${colorLabel}` : ''}`
    : t('favorite.add')

  const titleSegment: WordSegment = {
    type: 'word',
    start: 0,
    end: entry.lemma.length,
    text: entry.lemma,
    lemma: entry.lemma,
    sentenceIndex: 0,
  }

  /**
   * 예문 안의 단어도 문서와 같은 기준으로 lemma 를 찾는다 — 그 토막내기는
   * `ExampleSentence` 가 맡는다 (퀴즈와 같은 것을 쓴다).
   */
  const openDictionary = (segment: WordSegment, lemma: string, anchor: HTMLElement) => {
    setDictionaryTarget({ segment, lemma, anchor })
  }

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <button
            type="button"
            data-wordbook-lemma={entry.lemma}
            onClick={(event) => openDictionary(titleSegment, entry.lemma, event.currentTarget)}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium hover:text-accent"
          >
            {entry.lemma}
          </button>
          {entry.surfaces.length > 1 && (
            <span className="text-ink-muted shrink-0 text-[11px]">
              {entry.surfaces.filter((s) => s !== entry.lemma).join(' / ')}
            </span>
          )}
        </div>
        <span className="text-ink-muted ml-auto shrink-0 text-[11px]">×{entry.count}</span>
      </div>

      {entry.sentence ? (
        <p className="text-ink-muted mt-0.5 line-clamp-2 text-xs leading-relaxed">
          <ExampleSentence
            sentence={entry.sentence}
            languageCode={languageCode}
            onWordClick={openDictionary}
          />
        </p>
      ) : (
        <p className="text-ink-muted mt-0.5 line-clamp-2 text-xs leading-relaxed">
          {t('wordbook.noContext')}
        </p>
      )}

      {entry.note && (
        <p
          data-wordbook-note
          className="text-ink-muted mt-0.5 line-clamp-2 text-xs leading-relaxed whitespace-pre-wrap italic"
        >
          {entry.note}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/*
          목록에서도 별을 붙이거나 뗀다 — ★ 탭에 들어온 뒤에 해제할 길이 없으면
          갇힌다. 문서 팝오버의 별과 같은 저장소라 어느 쪽에서 눌러도 같다.
        */}
        <button
          type="button"
          data-wordbook-favorite
          data-wordbook-favorite-color={entry.favorite ? starColor : undefined}
          data-wordbook-favorite-angle={entry.favorite ? starAngle : undefined}
          onClick={(event) =>
            requestFavoriteToggle(
              {
                languageCode,
                lemma: entry.lemma,
                surface: entry.lemma,
                anchor: event.currentTarget,
              },
              entry.favorite,
            )
          }
          aria-pressed={entry.favorite}
          aria-label={favoriteLabel}
          title={favoriteLabel}
          className={`focus-visible:outline-accent flex h-8 w-8 shrink-0 items-center justify-center rounded border transition focus-visible:outline-2 focus-visible:outline-offset-2 ${
            entry.favorite
              ? 'border-accent text-ink'
              : 'text-ink-muted border-line hover:border-accent'
          }`}
        >
          {/*
            The fill is the stored favorite color, but the theme-colored stroke
            keeps white/yellow stars visible on light backgrounds and black
            stars visible on dark ones. Filled vs outline carries the binary
            favorite state without relying on color perception.
          */}
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill={entry.favorite ? starColor : 'none'}
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
            style={
              entry.favorite
                ? { transform: `rotate(${starAngle}deg)`, transformOrigin: 'center' }
                : undefined
            }
          >
            <path d="M12 2.8l2.83 5.73 6.32.92-4.58 4.46 1.08 6.3L12 17.24l-5.65 2.97 1.08-6.3-4.58-4.46 6.32-.92L12 2.8z" />
          </svg>
        </button>
        <div className="flex gap-1" role="group" aria-label={t('status.group')}>
          {WORD_STATUSES.map((status: WordStatus) => {
            const active = entry.status === status
            return (
              <button
                key={status}
                type="button"
                onClick={() =>
                  setStatus(languageCode, entry.lemma, status, entry.lemma, 'wordbook')
                }
                aria-pressed={active}
                aria-label={t(`status.${status}`)}
                title={t(`status.${status}`)}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  active
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'text-ink-muted border-line hover:border-accent'
                }`}
              >
                {t(`status.short${CAP[status]}`)}
              </button>
            )
          })}
        </div>

        <span className="text-ink-muted truncate text-[11px]">
          {entry.documentTitle}
          {entry.documentCount > 1 && ` +${entry.documentCount - 1}`}
        </span>
      </div>

      {/*
        문서에서 뜨는 것과 같은 박스다 — 상태 버튼과 사전이 함께 있다.
        단어장에서는 사전을 바로 보여준다. 같은 컴포넌트이므로 조회·표시가 같다.
      */}
      {dictionaryTarget && (
        <WordPopover
          segment={dictionaryTarget.segment}
          lemma={dictionaryTarget.lemma}
          languageCode={languageCode}
          anchor={dictionaryTarget.anchor}
          startWithDictionary
          onClose={() => setDictionaryTarget(null)}
        />
      )}
      {favoriteConfirmation}
    </li>
  )
}

const CAP = { known: 'Known', unsure: 'Unsure', unknown: 'Unknown' } as const