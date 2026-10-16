import { useMemo, useState } from 'react'

import { useLanguagesStore } from '../../app/stores/languages'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import type { LanguageCode, Segment, WordStatus } from '../../types'
import { DictionaryPanel } from '../dictionary/DictionaryPanel'
import { Popover } from '../reader/Popover'
import { buildWordbook } from '../wordbook/buildWordbook'
import { QuizPrompt } from './QuizPrompt'
import { QuizSentence } from './QuizSentence'
import {
  drawWords,
  nextStatus,
  quizPool,
  sessionSizeOptions,
  summarize,
  type QuizWord,
} from './quizSession'

type Phase = 'setup' | 'session' | 'summary'

type WordSegment = Extract<Segment, { type: 'word' }>

/** 사전 상자를 띄운 자리 — 퀴즈의 단어일 수도, 예문 속 단어일 수도 있다 */
type DictionaryTarget = {
  lemma: string
  surface: string
  anchor: HTMLElement
}

/** 사전 상자는 단어 팝오버와 같은 폭을 쓴다 — 같은 사전이 두 곳에서 달라 보이지 않게 */
const DICTIONARY_WIDTH = 300

/**
 * 단어 퀴즈.
 *
 * 아직 확실하지 않은 단어(헷갈림·모름)만 무작위로 뽑아, 앎/헷갈림/모름으로 다시
 * 표시하게 한다. 세 상태는 문서에서 누르는 것과 같은 저장을 건드린다 — 퀴즈가
 * 따로 기록을 만들지 않는다. 그래서 퀴즈를 마치면 단어장의 숫자가 곧바로 맞는다.
 *
 * 사전을 먼저 보면 '앎' 을 고를 수 없다. 답을 확인하고 나서 알았다고 할 수는
 * 없기 때문이다 — 이 한 가지가 퀴즈를 퀴즈이게 하는 규칙이다.
 */
export function QuizView() {
  const t = useTranslation()
  const languageName = useLanguageName()
  const enrolled = useLanguagesStore((s) => s.enrolled)
  const occurrences = useOccurrencesStore((s) => s.byLanguage)
  const byKey = useWordStatesStore((s) => s.byKey)
  const pressStatus = useWordStatesStore((s) => s.pressStatus)

  const [phase, setPhase] = useState<Phase>('setup')
  const [languageCode, setLanguageCode] = useState<LanguageCode | null>(enrolled[0] ?? null)
  /** 고른 개수. 아직 안 골랐으면 가장 큰 선택지로 본다 */
  const [size, setSize] = useState<number | null>(null)

  const [words, setWords] = useState<QuizWord[]>([])
  const [index, setIndex] = useState(0)
  /** 지금 단어에 낸 답 (아직 없으면 null) */
  const [answer, setAnswer] = useState<WordStatus | null>(null)
  /** 낸 답들 — 끝난 화면의 요약이 이걸 센다 */
  const [results, setResults] = useState<WordStatus[]>([])
  /** 사전을 먼저 본 단어인가 — 보면 '앎' 이 잠긴다 */
  const [peeked, setPeeked] = useState(false)
  const [dictionaryTarget, setDictionaryTarget] = useState<DictionaryTarget | null>(null)

  /** 이 언어에서 낼 수 있는 단어 — 단어장과 같은 재료를 쓴다 */
  const pool = useMemo(() => {
    if (!languageCode) return []
    return quizPool(
      buildWordbook({
        languageCode,
        occurrences: occurrences[languageCode] ?? [],
        byKey,
      }),
    )
  }, [languageCode, occurrences, byKey])

  const sizeOptions = useMemo(() => sessionSizeOptions(pool.length), [pool.length])
  const chosenSize =
    size !== null && sizeOptions.includes(size) ? size : (sizeOptions[sizeOptions.length - 1] ?? null)

  const start = () => {
    if (!languageCode || chosenSize === null) return
    setWords(drawWords(pool, chosenSize))
    setIndex(0)
    setAnswer(null)
    setResults([])
    setPeeked(false)
    setPhase('session')
  }

  const answerWord = (pressed: WordStatus) => {
    const word = words[index]
    if (!word || answer !== null || !languageCode) return
    // 규칙은 quizSession 이 정한다 — 화면은 그 결과를 그대로 저장할 뿐이다
    const result = nextStatus(word.status, pressed)
    // 누른 단추를 센다 (저장되는 상태가 아니다) — 모름에서 앎을 눌러도 앎을 세야 한다
    pressStatus(languageCode, word.lemma, result, pressed, word.surface)
    setAnswer(result)
    setResults((prev) => {
      const next = [...prev]
      next[index] = result
      return next
    })
  }

  const goNext = () => {
    if (index + 1 >= words.length) {
      setPhase('summary')
      return
    }
    setIndex(index + 1)
    setAnswer(null)
    setPeeked(false)
    setDictionaryTarget(null)
  }

  const backToSetup = () => {
    setPhase('setup')
    setWords([])
    setResults([])
    setAnswer(null)
    setPeeked(false)
    setDictionaryTarget(null)
  }

  /** 예문 속 단어를 누르면 그 단어의 뜻을 띄운다 — 단어장의 예문과 같은 길 */
  const openSentenceWord = (segment: WordSegment, lemma: string, anchor: HTMLElement) => {
    setDictionaryTarget({ lemma, surface: segment.text, anchor })
  }

  // ── 처음 화면: 언어와 개수 고르기 ──
  if (phase === 'setup') {
    return (
      <section className="mx-auto w-full max-w-2xl px-5 py-8">
        <h1 className="text-lg font-semibold">{t('quiz.title')}</h1>
        <p className="text-ink-muted mt-1 text-sm">{t('quiz.lead')}</p>
        {/*
          상태 전이 규칙을 미리 밝힌다 — 모름에서 앎을 눌러도 곧바로 앎이 되지 않는
          이유를 모르면, 퀴즈가 말을 안 듣는 것처럼 보인다.
        */}
        <p data-quiz-rule className="text-ink-muted mt-2 text-xs leading-relaxed">
          {t('quiz.ruleHint')}
        </p>

        <h2 className="text-ink-muted mt-6 mb-2 text-xs font-medium">{t('quiz.pickLanguage')}</h2>
        <div className="flex flex-wrap gap-2">
          {enrolled.map((code) => (
            <button
              key={code}
              type="button"
              data-quiz-language={code}
              aria-pressed={code === languageCode}
              onClick={() => {
                setLanguageCode(code)
                setSize(null)
              }}
              className={`rounded-xl border px-4 py-2 text-sm transition ${
                code === languageCode
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-line bg-surface text-ink-muted hover:text-ink'
              }`}
            >
              {languageName(code)}
            </button>
          ))}
        </div>

        {languageCode &&
          (sizeOptions.length === 0 ? (
            <p className="text-ink-muted mt-6 text-sm">{t('quiz.none')}</p>
          ) : (
            <>
              <h2 className="text-ink-muted mt-6 mb-2 text-xs font-medium">
                {t('quiz.countLabel')}
              </h2>
              <div className="flex flex-wrap gap-2">
                {sizeOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    data-quiz-size={option}
                    aria-pressed={option === chosenSize}
                    onClick={() => setSize(option)}
                    className={`rounded-lg border px-4 py-2 text-sm transition ${
                      option === chosenSize
                        ? 'border-accent text-ink'
                        : 'border-line text-ink-muted hover:text-ink'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-quiz-start
                onClick={start}
                className="bg-accent text-accent-ink mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-medium"
              >
                {t('quiz.start')}
              </button>
            </>
          ))}
      </section>
    )
  }

  // ── 끝난 화면: 요약 ──
  if (phase === 'summary') {
    const counts = summarize(results)
    return (
      <section className="mx-auto w-full max-w-2xl px-5 py-8">
        <h1 data-quiz-summary className="text-lg font-semibold">
          {t('quiz.done')}
        </h1>
        <p className="text-ink-muted mt-1 text-sm">{t('quiz.doneHint')}</p>

        <ul className="mt-6 flex flex-wrap gap-4">
          <SummaryCount label={t('quiz.summaryKnown')} status="known" count={counts.known} />
          <SummaryCount label={t('quiz.summaryUnsure')} status="unsure" count={counts.unsure} />
          <SummaryCount label={t('quiz.summaryNew')} status="unknown" count={counts.unknown} />
        </ul>

        <button
          type="button"
          data-quiz-again
          onClick={backToSetup}
          className="border-line text-ink hover:border-accent mt-8 w-full rounded-lg border px-4 py-2.5 text-sm"
        >
          {t('quiz.again')}
        </button>
      </section>
    )
  }

  // ── 퀴즈: 한 단어를 풀고 다음으로 ──
  const word = words[index]
  if (!word || !languageCode) return null

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-8">
      <p data-quiz-progress className="text-ink-muted text-xs">
        {t('quiz.progress', { done: index + 1, total: words.length })}
      </p>

      {/*
        별은 상태와 무관하므로 문제를 푸는 도중 계속 보인다 — 붙이거나 뗄 수 있다.
        key 는 단어가 바뀔 때 색창을 닫기 위함이다.
      */}
      <QuizPrompt key={word.lemma} word={word} languageCode={languageCode} />

      <div className="mt-10 flex justify-center gap-2">
        {/* 답은 한 번뿐이다 — 답한 뒤에는 세 단추 모두 잠긴다.
            사전을 먼저 본 단어는 '앎' 이 잠긴다 (아래 사전 단추 참고) */}
        <button
          type="button"
          data-quiz-answer="known"
          aria-pressed={answer === 'known'}
          disabled={answer !== null || peeked}
          onClick={() => answerWord('known')}
          className={`rounded-lg border px-5 py-2.5 text-sm transition disabled:opacity-30 ${
            answer === 'known' ? 'border-accent text-ink' : 'border-line text-ink-muted hover:text-ink'
          }`}
        >
          {t('quiz.know')}
        </button>
        <button
          type="button"
          data-quiz-answer="unsure"
          aria-pressed={answer === 'unsure'}
          disabled={answer !== null}
          onClick={() => answerWord('unsure')}
          className={`rounded-lg border px-5 py-2.5 text-sm transition disabled:opacity-30 ${
            answer === 'unsure' ? 'border-accent text-ink' : 'border-line text-ink-muted hover:text-ink'
          }`}
        >
          {t('quiz.unsure')}
        </button>
        <button
          type="button"
          data-quiz-answer="unknown"
          aria-pressed={answer === 'unknown'}
          disabled={answer !== null}
          onClick={() => answerWord('unknown')}
          className={`rounded-lg border px-5 py-2.5 text-sm transition disabled:opacity-30 ${
            answer === 'unknown' ? 'border-accent text-ink' : 'border-line text-ink-muted hover:text-ink'
          }`}
        >
          {t('quiz.new')}
        </button>
      </div>

      {/* 답하기 전에도, 답한 뒤에도 쓸 수 있다. 먼저 보면 '앎' 이 잠길 뿐이다 */}
      <div className="mt-4 flex justify-center">
        <button
          type="button"
          data-quiz-dictionary
          onClick={(event) => {
            if (answer === null) setPeeked(true)
            setDictionaryTarget({
              lemma: word.lemma,
              surface: word.surface,
              anchor: event.currentTarget,
            })
          }}
          className="border-line text-ink-muted hover:text-ink hover:border-accent rounded-lg border px-4 py-2 text-sm"
        >
          {t('dictionary.button')}
        </button>
      </div>

      {/* 답한 뒤에만 문맥을 보여 준다 — 답을 고르기 전에 보면 퀴즈가 아니다 */}
      {answer !== null && word.sentence && (
        <QuizSentence
          sentence={word.sentence}
          documentTitle={word.documentTitle}
          languageCode={languageCode}
          onWordClick={openSentenceWord}
        />
      )}

      {answer !== null && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            data-quiz-next
            onClick={goNext}
            className="bg-accent text-accent-ink rounded-lg px-6 py-2.5 text-sm font-medium"
          >
            {t('quiz.next')}
          </button>
        </div>
      )}

      {dictionaryTarget && (
        <Popover
          anchor={dictionaryTarget.anchor}
          anchorKey={`quiz:${index}:${dictionaryTarget.lemma}:${dictionaryTarget.surface}`}
          onClose={() => setDictionaryTarget(null)}
          width={DICTIONARY_WIDTH}
        >
          <DictionaryPanel
            languageCode={languageCode}
            lemma={dictionaryTarget.lemma}
            surface={dictionaryTarget.surface}
          />
        </Popover>
      )}
    </section>
  )
}

/** 끝난 화면의 한 칸 — 숫자와 이름 */
function SummaryCount({
  label,
  status,
  count,
}: {
  label: string
  status: WordStatus
  count: number
}) {
  return (
    <li className="border-line flex min-w-24 flex-col rounded-xl border px-4 py-3">
      <span data-quiz-count={status} className="text-2xl font-semibold">
        {count}
      </span>
      <span className="text-ink-muted text-xs">{label}</span>
    </li>
  )
}
