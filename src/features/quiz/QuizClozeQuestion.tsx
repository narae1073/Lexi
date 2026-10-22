import { useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import type { WordStatus } from '../../types'
import type { WordbookEntry } from '../wordbook/buildWordbook'
import { QuizAnswerButtons } from './QuizAnswerButtons'
import { QuizCloze } from './QuizCloze'
import { buildChoices, pickDistractors, type QuizChoice } from './quizChoices'
import type { QuizWord } from './quizSession'

/**
 * 앎 단어 복습 — 빈칸에 들어갈 단어를 고른다.
 *
 * 세 단추 대신 단어 세 개를 낸다: 정답 하나 + 단어장에서 고른 오답 둘.
 * 맞히면 앎, 틀리면 모름이다 — 이 모드에는 헷갈림이 없다.
 *
 * 선택지는 마운트할 때 한 번만 고른다 (부모가 단어마다 key 를 준다). 답한 뒤
 * 다시 계산하면 화면에서 선택지가 바뀌어 버린다.
 *
 * 단어가 모자라 오답 둘을 만들 수 없으면 기존 세 단추로 되돌아간다.
 */
export function QuizClozeQuestion({
  word,
  cloze,
  entries,
  sessionWords,
  answer,
  onAnswer,
}: {
  word: QuizWord
  /** 빈칸으로 가린 예문 */
  cloze: string
  entries: WordbookEntry[]
  /** 이번 세션에 뽑힌 단어들 — 오답 후보로 먼저 쓴다 */
  sessionWords: QuizWord[]
  answer: WordStatus | null
  onAnswer: (status: WordStatus) => void
}) {
  const t = useTranslation()
  const [chosen, setChosen] = useState<QuizChoice | null>(null)

  const [choices] = useState(() => {
    const correct: QuizChoice = { lemma: word.lemma, label: word.surface }
    const distractors = pickDistractors(entries, word.lemma, word.sentence, {
      count: 8,
      // 이번 세션 단어를 먼저 — 대부분 여기서 오답 둘이 채워진다
      sessionEntries: sessionWords.map((item) => ({
        lemma: item.lemma,
        surfaces: [item.surface],
        status: item.status,
      })),
    })
    return buildChoices(correct, distractors, 2)
  })

  const answered = answer !== null

  if (choices === null) {
    return (
      <QuizCloze text={cloze}>
        <p data-quiz-choices-few className="text-ink-muted mt-3 text-xs">
          {t('quiz.choicesFew')}
        </p>
        <div className="mt-4">
          <QuizAnswerButtons answer={answer} knownDisabled={answered} onAnswer={onAnswer} />
        </div>
      </QuizCloze>
    )
  }

  const correct = chosen?.lemma === word.lemma

  return (
    <QuizCloze text={cloze}>
      {answered && (
        <p
          data-quiz-choice-result={correct ? 'correct' : 'wrong'}
          className={`mt-3 text-xs font-medium ${
            correct ? 'text-accent' : 'text-status-unknown'
          }`}
        >
          {correct ? t('quiz.correct') : t('quiz.wrong')}
        </p>
      )}

      <div data-quiz-choices className="mt-3 flex flex-col gap-1.5">
        {choices.map((choice) => {
          const isCorrect = choice.lemma === word.lemma
          const isChosen = chosen?.lemma === choice.lemma
          const tone = !answered
            ? 'border-line text-ink hover:border-accent'
            : isCorrect
              ? 'border-accent text-ink'
              : isChosen
                ? 'border-status-unknown bg-status-unknown-bg text-status-unknown'
                : 'border-line text-ink-muted'

          return (
            <button
              key={`${choice.lemma}:${choice.label}`}
              type="button"
              data-quiz-choice={choice.lemma}
              aria-pressed={isChosen}
              disabled={answered}
              onClick={() => {
                setChosen(choice)
                onAnswer(isCorrect ? 'known' : 'unknown')
              }}
              className={`flex items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-left text-sm transition disabled:cursor-default ${tone}`}
            >
              <span className="min-w-0 break-words">{choice.label}</span>
              {answered && isCorrect && (
                <span aria-hidden className="shrink-0">
                  ✓
                </span>
              )}
              {answered && isChosen && !isCorrect && (
                <span aria-hidden className="shrink-0">
                  ✗
                </span>
              )}
            </button>
          )
        })}
      </div>
    </QuizCloze>
  )
}
