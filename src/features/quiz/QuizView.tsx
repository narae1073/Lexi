import { useEffect, useMemo, useState } from 'react'

import { useAuthStore } from '../../app/stores/auth'
import { useLanguagesStore } from '../../app/stores/languages'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { useSyncStore } from '../../app/stores/sync'
import { useWordbookStore } from '../../app/stores/wordbook'
import { wordKey, useWordStatesStore } from '../../app/stores/wordStates'
import { statusPillClass } from '../../lib/color'
import type { Segment, WordStatus } from '../../types'
import { DictionaryPanel } from '../dictionary/DictionaryPanel'
import { Popover } from '../reader/Popover'
import { buildWordbook } from '../wordbook/buildWordbook'
import {
  preparationProgress,
  resolveWordbookPresentation,
  type ProjectionWordbookEntry,
} from '../wordbook/wordbookProjection'
import { useProjectionPauseReady } from '../wordbook/useProjectionPause'
import { QuizAnswerButtons } from './QuizAnswerButtons'
import { QuizProgressChart } from './QuizProgressChart'
import { QuizClozeQuestion } from './QuizClozeQuestion'
import { QuizPrompt } from './QuizPrompt'
import { QuizSentence } from './QuizSentence'
import { useQuizSessionStore } from './quizSessionStore'
import {
  blankWord,
  defaultSessionSize,
  nextStatus,
  quizPool,
  reviewPool,
  selectSession,
  sessionChanges,
  sessionSizeOptions,
  summarize,
} from './quizSession'

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
 * Stable empty projection list.
 *
 * A selector that returns a fresh `[]` on every store read makes Zustand v5's
 * `useSyncExternalStore` see a changed snapshot forever (React #185). The quiz
 * reads this slice before the local producer has built its rows.
 */
const EMPTY_PROJECTION: ProjectionWordbookEntry[] = []

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
  const localOnly = useSyncStore((s) => s.localOnly)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const syncNow = useSyncStore((s) => s.syncNow)
  const userId = useAuthStore((s) => s.user?.id ?? null)

  const {
    phase,
    languageCode: storedLanguageCode,
    size,
    words,
    index,
    sessionEntries,
    answer,
    results,
    peeked,
    selectLanguage,
    selectSize,
    startSession,
    recordAnswer,
    advance: advanceSession,
    backToSetup: resetToSetup,
    markPeeked,
  } = useQuizSessionStore()
  const languageCode =
    storedLanguageCode && enrolled.includes(storedLanguageCode)
      ? storedLanguageCode
      : (enrolled[0] ?? null)
  const projectionEntries = useWordbookStore(
    (s) => s.entriesByLanguage[languageCode ?? ''] ?? EMPTY_PROJECTION,
  )
  const projectionComplete = useWordbookStore(
    (s) => s.projectionCompleteByLanguage[languageCode ?? ''] === true,
  )
  const projectionLoaded = useWordbookStore(
    (s) => s.loadedLanguages[languageCode ?? ''] === true,
  )
  const completeByLanguage = useWordbookStore((s) => s.projectionCompleteByLanguage)
  const languagePause = useWordbookStore((s) =>
    languageCode ? s.projectionPauseByLanguage[languageCode] : undefined,
  )
  const refreshFromStore = useWordbookStore((s) => s.refreshFromStore)
  const refreshReadiness = useWordbookStore((s) => s.refreshProjectionReadiness)
  const [dictionaryTarget, setDictionaryTarget] = useState<DictionaryTarget | null>(null)

  /** 지금 단어의 메모 — 답한 뒤 뜻과 함께 다시 본다 */
  const sessionNote = useWordStatesStore((s) => {
    const current = words[index]
    if (!languageCode || !current) return undefined
    return s.byKey[wordKey(languageCode, current.lemma)]?.note
  })

  /** 이 언어의 단어장 — 퀴즈와 복습의 공통 재료 */
  const projectionReady = localOnly ? projectionLoaded : projectionComplete && projectionLoaded
  const presentation = resolveWordbookPresentation({
    localOnly,
    projectionReady,
    projectionPaused: languagePause !== undefined,
    hasLocalWordbook: (occurrences[languageCode ?? '']?.length ?? 0) > 0,
  })
  const source = presentation.source
  const preparation = preparationProgress(completeByLanguage, enrolled)
  const quotaPaused = presentation.showPaused && languagePause?.reason === 'quota'
  const statePaused = presentation.showPaused && languagePause?.reason === 'state'
  const quotaMinutes = Math.max(
    1,
    Math.ceil((languagePause?.retryAfterSeconds ?? 60) / 60),
  )
  const quotaHint = !quotaPaused
    ? null
    : languagePause?.quotaBucket === 'sync'
      ? t('wordbook.quotaDailyPausedHint', { minutes: quotaMinutes })
      : languagePause?.quotaBucket === 'page'
        ? t('wordbook.quotaPagePausedHint')
        : t('wordbook.quotaPausedHint', { minutes: quotaMinutes })
  const pauseReady = useProjectionPauseReady(languagePause)

  useEffect(() => {
    if (localOnly) return
    void refreshReadiness(userId)
  }, [localOnly, lastSyncedAt, refreshReadiness, userId])

  useEffect(() => {
    if (!languageCode || localOnly || !projectionComplete) return
    void refreshFromStore(languageCode)
  }, [languageCode, localOnly, projectionComplete, refreshFromStore, lastSyncedAt])

  const entries = useMemo(() => {
    // 세션·요약에서는 시작할 때 떠 둔 사본을 쓴다. 답할 때마다 byKey 가 바뀌는데
    // 그때마다 등장 기록 전체를 다시 훑으면 큰 단어장에서 화면이 멈춘다.
    if (phase !== 'setup') return sessionEntries
    if (!languageCode) return []
    // Local-only mode reads the same `wordbookEntries` rows as account mode once
    // the local producer has built them. The occurrence builder is only the
    // first-start fallback, before that build finishes.
    if (localOnly && projectionReady) return projectionEntries
    // An account whose projection is still incomplete (an R2 upgrade) keeps the
    // occurrence builder. A new device has no local rows and shows the preparing
    // state instead.
    if (source === 'local') {
      return buildWordbook({
        languageCode,
        occurrences: occurrences[languageCode] ?? [],
        byKey,
      })
    }
    if (source === 'projection') return projectionEntries
    return []
  }, [
    phase,
    languageCode,
    localOnly,
    projectionReady,
    source,
    occurrences,
    byKey,
    sessionEntries,
    projectionEntries,
  ])

  /** 아직 확실하지 않은 단어 — 새로 배우는 재료 */
  const pool = useMemo(() => quizPool(entries), [entries])

  /** 기한이 된 앎 단어 — 잊을 때쯤 다시 꺼낸다 */
  const reviews = useMemo(() => reviewPool(entries), [entries])

  const sizeOptions = useMemo(
    () => sessionSizeOptions(pool.length + reviews.length),
    [pool.length, reviews.length],
  )
  // 아직 고르지 않았으면 기본 개수(50) — 가진 것이 50 미만이면 그 안에서 가장 큰 것
  const chosenSize =
    size !== null && sizeOptions.includes(size) ? size : defaultSessionSize(sizeOptions)

  const start = () => {
    if (!languageCode || chosenSize === null) return
    // 이 시점의 단어장을 세션 내내 쓴다 — 답할 때마다 다시 만들지 않는다
    startSession({
      languageCode,
      size: chosenSize,
      entries,
      words: selectSession(pool, reviews, chosenSize),
    })
  }

  const answerWord = (pressed: WordStatus) => {
    const word = words[index]
    if (!word || answer !== null || !languageCode) return
    // 규칙은 quizSession 이 정한다 — 화면은 그 결과를 그대로 저장할 뿐이다
    const result = nextStatus(word.status, pressed)
    // 누른 단추를 센다 (저장되는 상태가 아니다) — 모름에서 앎을 눌러도 앎을 세야 한다
    pressStatus(languageCode, word.lemma, result, pressed, word.surface)
    recordAnswer(result)
  }

  const goNext = () => {
    // The last question may have left a dictionary anchored to a question
    // node that is about to unmount. Start the summary with no stale target.
    setDictionaryTarget(null)
    advanceSession()
  }

  const backToSetup = () => {
    resetToSetup()
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
        {/* 앎 단어도 영영 빠지지 않는다 — 간격을 두고 다시 나온다는 것을 미리 밝힌다 */}
        <p data-quiz-review className="text-ink-muted mt-1 text-xs leading-relaxed">
          {t('quiz.reviewHint')}
        </p>

        <h2 className="text-ink-muted mt-6 mb-2 text-xs font-medium">{t('quiz.pickLanguage')}</h2>
        <div className="flex flex-wrap gap-2">
          {enrolled.map((code) => (
            <button
              key={code}
              type="button"
              data-quiz-language={code}
              aria-pressed={code === languageCode}
              onClick={() => selectLanguage(code)}
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

        {languageCode && <QuizProgressChart key={languageCode} languageCode={languageCode} />}

        {presentation.showPaused && (
          <div
            role="status"
            data-quiz-paused
            className="border-status-unsure bg-status-unsure-bg mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-xs"
          >
            <span className="text-status-unsure min-w-0 flex-1">
              <strong className="font-medium">
                {t(quotaPaused ? 'wordbook.quotaPaused' : statePaused ? 'wordbook.statePaused' : 'wordbook.paused')}
              </strong>{' '}
              {quotaPaused
                ? quotaHint
                : statePaused
                  ? t('wordbook.statePausedHint')
                  : t('wordbook.pausedHint')}
            </span>
            {presentation.showContinue && pauseReady && (
              <button
                type="button"
                onClick={() => void syncNow()}
                className="border-status-unsure text-status-unsure shrink-0 rounded-md border px-2.5 py-1 font-medium hover:bg-surface"
              >
                {t('wordbook.pausedContinue')}
              </button>
            )}
          </div>
        )}

        {languageCode &&
          (source === 'preparing' ? (
            <section role="status" data-quiz-preparing className="border-line mt-6 rounded-xl border px-4 py-5">
              <h2 className="text-sm font-medium">{t('wordbook.preparing')}</h2>
              <p className="text-ink-muted mt-1 text-xs leading-relaxed">
                {t('quiz.preparing')}
              </p>
              <p className="text-ink-muted mt-3 text-xs">
                {t('wordbook.preparingProgress', {
                  ready: preparation.ready,
                  total: preparation.total,
                })}
              </p>
              <div
                role="progressbar"
                aria-valuenow={preparation.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('wordbook.preparing')}
                className="bg-line mt-2 h-1.5 w-full overflow-hidden rounded-full"
              >
                <span
                  className="bg-accent block h-full rounded-full"
                  style={{ width: `${preparation.percent}%` }}
                />
              </div>
            </section>
          ) : sizeOptions.length === 0 ? (
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
                    onClick={() => selectSize(option)}
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
    // 단어별 변화 — 푼 순서 그대로, 강조 없이 나열한다
    const changes = sessionChanges(words, results)
    const changedCount = changes.filter((change) => change.changed).length
    const statusLabel = (status: WordStatus) =>
      status === 'known' ? t('quiz.know') : status === 'unsure' ? t('quiz.unsure') : t('quiz.new')
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

        {changes.length > 0 && (
          <section className="mt-8">
            <div className="flex items-baseline justify-between">
              <h2 className="text-ink-muted text-xs font-medium">{t('quiz.wordChanges')}</h2>
              <span data-quiz-changed-count className="text-ink-muted text-xs">
                {t('quiz.changedCount', { changed: changedCount, total: changes.length })}
              </span>
            </div>
            <ul className="mt-3 flex flex-col gap-1.5">
              {changes.map((change, i) => {
                const summaryWord = words[i]
                return (
                  <li key={`${summaryWord?.lemma ?? change.surface}:${i}`} data-quiz-change>
                    <button
                      type="button"
                      data-quiz-change-button
                      aria-haspopup="dialog"
                      aria-label={`${t('dictionary.openFor', { word: change.surface })}: ${statusLabel(change.before)} → ${statusLabel(change.after)}`}
                      title={t('dictionary.openFor', { word: change.surface })}
                      onClick={(event) => {
                        if (!summaryWord) return
                        setDictionaryTarget({
                          lemma: summaryWord.lemma,
                          surface: summaryWord.surface,
                          anchor: event.currentTarget,
                        })
                      }}
                      className="border-line hover:border-accent focus-visible:outline-accent group flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{change.surface}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <ChangePill status={change.before} />
                        <span className="text-ink-muted text-xs">→</span>
                        <ChangePill status={change.after} />
                        <DictionaryIcon />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <button
          type="button"
          data-quiz-again
          onClick={backToSetup}
          className="border-line text-ink hover:border-accent mt-8 w-full rounded-lg border px-4 py-2.5 text-sm"
        >
          {t('quiz.again')}
        </button>

        {dictionaryTarget && languageCode && (
          <Popover
            anchor={dictionaryTarget.anchor}
            anchorKey={`quiz-summary:${dictionaryTarget.lemma}:${dictionaryTarget.surface}`}
            onClose={() => setDictionaryTarget(null)}
            width={DICTIONARY_WIDTH}
          >
            <div data-quiz-summary-dictionary={dictionaryTarget.surface}>
              <DictionaryPanel
                languageCode={languageCode}
                lemma={dictionaryTarget.lemma}
                surface={dictionaryTarget.surface}
              />
            </div>
          </Popover>
        )}
      </section>
    )
  }

  // ── 퀴즈: 한 단어를 풀고 다음으로 ──
  const word = words[index]
  if (!word || !languageCode) return null

  /**
   * 앎 단어 복습은 빈칸으로 낸다 — 답을 누르기 전에는 단어를 보여 주지 않는다.
   * 빈칸을 만들 수 없는 문장이면 기존 방식(단어 → 뜻)으로 되돌아간다.
   */
  const clozeText = word.status === 'known' ? blankWord(word.sentence, word.surface) : null
  const isCloze = clozeText !== null

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-8">
      <p data-quiz-progress className="text-ink-muted text-xs">
        {t('quiz.progress', { done: index + 1, total: words.length })}
      </p>

      {/*
        별은 상태와 무관하므로 문제를 푸는 도중 계속 보인다 — 붙이거나 뗄 수 있다.
        key 는 단어가 바뀔 때 색창을 닫기 위함이다. 빈칸 문제에서는 답한 뒤에만
        단어를 공개한다 (그 전에는 선택지 안에 숨어 있다).
      */}
      {isCloze ? (
        <>
          <QuizClozeQuestion
            key={word.lemma}
            word={word}
            cloze={clozeText}
            entries={entries}
            sessionWords={words}
            answer={answer}
            onAnswer={answerWord}
          />
          {answer !== null && (
            <QuizPrompt key={`reveal:${word.lemma}`} word={word} languageCode={languageCode} />
          )}
        </>
      ) : (
        <QuizPrompt key={word.lemma} word={word} languageCode={languageCode} />
      )}

      {/* 앎 복습은 선택지가 답을 대신한다 — 세 단추는 새 단어·헷갈림의 몫이다 */}
      {!isCloze && (
        <div className="mt-10">
          <QuizAnswerButtons
            answer={answer}
            knownDisabled={answer !== null || peeked}
            onAnswer={answerWord}
          />
        </div>
      )}

      {/* 새 단어·헷갈림 문제에서만 사전을 연다. 앎 복습은 답한 뒤 뜻이 자동으로 나온다.
          먼저 보면 '앎' 이 잠긴다 */}
      {!isCloze && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            data-quiz-dictionary
            onClick={(event) => {
              if (answer === null) markPeeked()
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
      )}

      {/* 답한 뒤에만 뜻을 보여 준다 — 답을 고르기 전에 보면 퀴즈가 아니다 */}
      {answer !== null && (
        <section data-quiz-meaning className="border-line mt-6 rounded-xl border px-4 py-3">
          <h2 className="text-ink-muted mb-2 text-xs font-medium">{t('quiz.meaning')}</h2>
          <DictionaryPanel languageCode={languageCode} lemma={word.lemma} surface={word.surface} />
        </section>
      )}

      {/* 사용자가 적어 둔 메모도 답한 뒤에 다시 본다 — 뜻과 함께 기억을 붙잡는 재료 */}
      {answer !== null && sessionNote && (
        <section data-quiz-note className="border-line mt-3 rounded-xl border px-4 py-3">
          <h2 className="text-ink-muted mb-1 text-xs font-medium">{t('note.label')}</h2>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{sessionNote}</p>
        </section>
      )}

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

/** 완료 화면 카드의 조용한 사전 표식 — 카드 전체가 단추라는 것을 알린다 */
function DictionaryIcon() {
  return (
    <svg
      data-quiz-dictionary-icon
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-ink-muted group-hover:text-accent h-4 w-4 shrink-0 transition-colors"
    >
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" />
    </svg>
  )
}

/** 단어별 변화의 상태 배지 — 퀴즈 단추와 같은 말. 바뀌었는지와 무관하게 같은 모양이다 */
function ChangePill({ status }: { status: WordStatus }) {
  const t = useTranslation()
  const label = status === 'known' ? t('quiz.know') : status === 'unsure' ? t('quiz.unsure') : t('quiz.new')
  return (
    <span
      data-quiz-status={status}
      className={`rounded-md border px-2 py-0.5 text-xs ${statusPillClass(status)}`}
    >
      {label}
    </span>
  )
}
