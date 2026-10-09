import { useMemo, useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import {
  WORD_STATUSES,
  type LanguageCode,
  type Segment,
  type WordStatus,
} from '../../types'
import { WordPopover } from '../reader/WordPopover'
import { isCapitalisedPosition, tokenize } from '../reader/tokenizer'
import { resolveLemmasFromWords } from '../reader/surfaceLemma'
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
  const toggleFavorite = useWordStatesStore((s) => s.toggleFavorite)
  const [dictionaryTarget, setDictionaryTarget] = useState<DictionaryTarget | null>(null)

  const titleSegment: WordSegment = {
    type: 'word',
    start: 0,
    end: entry.lemma.length,
    text: entry.lemma,
    lemma: entry.lemma,
    sentenceIndex: 0,
  }

  /**
   * 예문 안의 단어도 문서와 같은 기준으로 lemma 를 찾는다.
   *
   * 예문은 문장 하나이므로 그 안에서만 본다 — 문서 전체의 표기 분포를 볼 수 없어
   * US/us 같은 경계는 문서와 다르게 갈릴 수 있다. 그래도 누른 표기는 그대로 사전에
   * 보내므로 조회 자체는 정확하다.
   */
  const sentenceTokens = useMemo(() => {
    if (!entry.sentence) return null
    const { segments, sentences } = tokenize(entry.sentence, languageCode)
    const lemmaOf = resolveLemmasFromWords(
      segments
        .filter((segment): segment is WordSegment => segment.type === 'word')
        .map((word) => ({
          text: word.text,
          sentenceInitial: isCapitalisedPosition(
            entry.sentence,
            sentences,
            word.start,
            word.sentenceIndex,
          ),
        })),
      languageCode,
    )
    return { segments, lemmaOf }
  }, [entry.sentence, languageCode])

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

      {sentenceTokens ? (
        <p className="text-ink-muted mt-0.5 line-clamp-2 text-xs leading-relaxed">
          {sentenceTokens.segments.map((segment) =>
            segment.type === 'word' ? (
              <button
                key={segment.start}
                type="button"
                data-wordbook-example={segment.text}
                onClick={(event) =>
                  openDictionary(
                    segment,
                    sentenceTokens.lemmaOf.get(segment.text) ?? segment.lemma,
                    event.currentTarget,
                  )
                }
                className="cursor-pointer rounded-sm hover:text-accent"
              >
                {segment.text}
              </button>
            ) : (
              <span key={segment.start}>{segment.text}</span>
            ),
          )}
        </p>
      ) : (
        <p className="text-ink-muted mt-0.5 line-clamp-2 text-xs leading-relaxed">
          {t('wordbook.noContext')}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/*
          목록에서도 별을 붙이거나 뗀다 — ★ 탭에 들어온 뒤에 해제할 길이 없으면
          갇힌다. 문서 팝오버의 별과 같은 저장소라 어느 쪽에서 눌러도 같다.
        */}
        <button
          type="button"
          onClick={() => toggleFavorite(languageCode, entry.lemma, entry.lemma)}
          aria-pressed={entry.favorite}
          aria-label={entry.favorite ? t('favorite.remove') : t('favorite.add')}
          title={entry.favorite ? t('favorite.remove') : t('favorite.add')}
          className={`rounded border px-2 py-0.5 text-[11px] transition ${
            entry.favorite
              ? 'border-accent text-accent'
              : 'text-ink-muted border-line hover:border-accent'
          }`}
        >
          {entry.favorite ? '★' : '☆'}
        </button>
        <div className="flex gap-1" role="group" aria-label={t('status.group')}>
          {WORD_STATUSES.map((status: WordStatus) => {
            const active = entry.status === status
            return (
              <button
                key={status}
                type="button"
                onClick={() => setStatus(languageCode, entry.lemma, status, entry.lemma)}
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
    </li>
  )
}

const CAP = { known: 'Known', unsure: 'Unsure', unknown: 'Unknown' } as const