import { useState } from 'react'

import {
  clampStarSize,
  STAR_COLOR_DEFAULT,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'
import { wordKey, useWordStatesStore } from '../../app/stores/wordStates'
import type { LanguageCode } from '../../types'
import { StarPalette } from '../reader/StarPalette'
import type { QuizWord } from './quizSession'

/**
 * 퀴즈의 문제 단어 + 즐겨찾기 별.
 *
 * 별 스티커는 본문(읽기 화면)과 겉모습이 같다 — 같은 기울기·색·크기, 같은 자리.
 * 다른 것은 하나: 본문의 별은 가상요소라 누를 수 없지만, 여기서는 누르는 것이
 * 목적이므로 진짜 단추로 만든다.
 *
 * 별은 상태와 무관하다 — 별을 붙여도 상태가 바뀌지 않고, 상태를 바꿔도 별이
 * 떨어지지 않는다. 그래서 문제를 푸는 도중 언제든 붙이거나 뗄 수 있다.
 */
export function QuizPrompt({
  word,
  languageCode,
}: {
  word: QuizWord
  languageCode: LanguageCode
}) {
  const t = useTranslation()
  const key = wordKey(languageCode, word.lemma)
  const favorite = useWordStatesStore((s) => s.byKey[key]?.favorite ?? false)
  const starColor = useWordStatesStore((s) => s.byKey[key]?.starColor ?? STAR_COLOR_DEFAULT)
  const starAngle = useWordStatesStore((s) => s.byKey[key]?.starAngle ?? 0)
  const toggleFavorite = useWordStatesStore((s) => s.toggleFavorite)
  const setStarColor = useWordStatesStore((s) => s.setStarColor)
  const starSize = clampStarSize(useSettingsStore((s) => s.favoriteStarSize))

  const [paletteOpen, setPaletteOpen] = useState(false)

  return (
    <div className="mt-10">
      <div className="flex justify-center">
        <span className="relative inline-block text-3xl font-semibold">
          <span data-quiz-word className="break-words">{word.surface}</span>

          {/* 별은 단어 글씨 크기 기준 퍼센트라 단어 안에서 같이 움직인다.
              본문의 가상요소(top:-0.45em, right:-0.25em)와 같은 자리에 둔다 */}
          <span
            className="absolute -top-[0.45em] -right-[0.25em] flex items-center gap-1"
            style={{ fontSize: `${starSize}%` }}
          >
            {favorite && (
              <button
                type="button"
                data-quiz-star-color
                aria-label={t('favorite.pickColor')}
                aria-expanded={paletteOpen}
                title={t('favorite.pickColor')}
                onClick={() => setPaletteOpen((open) => !open)}
                className="border-line flex shrink-0 items-center justify-center rounded-full border p-0.5 leading-none"
              >
                <span
                  aria-hidden
                  className="block h-3 w-3 rounded-full"
                  style={{ backgroundColor: starColor }}
                />
              </button>
            )}
            <button
              type="button"
              data-quiz-favorite
              aria-pressed={favorite}
              aria-label={favorite ? t('favorite.remove') : t('favorite.add')}
              title={favorite ? t('favorite.remove') : t('favorite.add')}
              onClick={() => {
                toggleFavorite(languageCode, word.lemma, word.surface)
                setPaletteOpen(false)
              }}
              style={
                favorite
                  ? { color: starColor, transform: `rotate(${starAngle}deg)` }
                  : undefined
              }
              className={`leading-none transition ${
                favorite
                  ? 'text-ink'
                  : 'text-ink-muted opacity-60 hover:opacity-100'
              }`}
            >
              {favorite ? '★' : '☆'}
            </button>
          </span>
        </span>
      </div>

      {/* 색창은 단어 아래 가운데 — 본문 팝오버와 같은 9색 */}
      {favorite && paletteOpen && (
        <div className="mx-auto mt-5 max-w-sm">
          <StarPalette
            current={starColor}
            onPick={(hex) => {
              setStarColor(languageCode, word.lemma, hex, word.surface)
              setPaletteOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}
