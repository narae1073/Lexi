import { useMemo } from 'react'

import type { LanguageCode, Segment } from '../../types'
import { useChineseUpgrade } from './chinese'
import { useJapaneseUpgrade } from './japanese'
import { isCapitalisedPosition, tokenize } from './tokenizer'
import { resolveLemmasFromWords } from './surfaceLemma'

type WordSegment = Extract<Segment, { type: 'word' }>

/**
 * 예문 한 줄 — 단어마다 눌러서 사전을 볼 수 있다.
 *
 * 단어장과 퀴즈가 **같은 것** 을 쓴다. 누르면 무슨 일이 일어나는지는 부르는 쪽이
 * 정한다 (단어장은 상태까지 담은 단어 팝오버, 퀴즈는 사전 상자). 그래서 여기서는
 * 토막내기와 누를 수 있는 단어만 책임진다.
 *
 * 예문은 문장 하나이므로 그 안에서만 lemma 를 찾는다 — 문서 전체의 표기 분포를 볼 수
 * 없어 US/us 같은 경계는 문서와 다르게 갈릴 수 있다. 그래도 누른 표기는 그대로
 * 사전에 보내므로 조회 자체는 정확하다.
 *
 * 일본어·중국어는 문서와 같은 업그레이드를 쓴다 — 본문이 lindera 인데 예문만 Intl 이면
 * 같은 단어를 다른 lemma 로 보게 된다.
 */
export function ExampleSentence({
  sentence,
  languageCode,
  onWordClick,
}: {
  sentence: string
  languageCode: LanguageCode
  onWordClick: (segment: WordSegment, lemma: string, anchor: HTMLElement) => void
}) {
  const jaUpgrade = useJapaneseUpgrade(sentence, languageCode)
  const zhUpgrade = useChineseUpgrade(sentence, languageCode)
  const upgrade = jaUpgrade ?? zhUpgrade

  const tokens = useMemo(() => {
    if (upgrade) {
      return {
        segments: upgrade.segments,
        lemmaOf: upgrade.lemmaByStart,
        keyedByStart: true as const,
      }
    }
    const { segments, sentences } = tokenize(sentence, languageCode)
    const lemmaOf = resolveLemmasFromWords(
      segments
        .filter((segment): segment is WordSegment => segment.type === 'word')
        .map((word) => ({
          text: word.text,
          sentenceInitial: isCapitalisedPosition(
            sentence,
            sentences,
            word.start,
            word.sentenceIndex,
          ),
        })),
      languageCode,
    )
    return { segments, lemmaOf, keyedByStart: false as const }
  }, [sentence, languageCode, upgrade])

  return (
    <>
      {tokens.segments.map((segment) =>
        segment.type === 'word' ? (
          <button
            key={segment.start}
            type="button"
            data-example-word={segment.text}
            onClick={(event) =>
              onWordClick(
                segment,
                tokens.keyedByStart
                  ? (tokens.lemmaOf.get(segment.start) ?? segment.lemma)
                  : (tokens.lemmaOf.get(segment.text) ?? segment.lemma),
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
    </>
  )
}
