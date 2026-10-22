import { useTranslation } from '../../app/stores/settings'
import type { WordStatus } from '../../types'

const ORDER: WordStatus[] = ['known', 'unsure', 'unknown']

/**
 * 앎/헷갈림/모름 세 단추.
 *
 * 퀴즈의 기본 답 방식이다. 앎 단추만 따로 잠글 수 있는 이유는 사전을 먼저
 * 본 단어에 '앎' 을 고를 수 없게 하기 위해서다 (퀴즈의 규칙).
 */
export function QuizAnswerButtons({
  answer,
  knownDisabled,
  onAnswer,
}: {
  answer: WordStatus | null
  /** 앎 단추만 잠글지 — 나머지는 답한 뒤에 함께 잠긴다 */
  knownDisabled: boolean
  onAnswer: (status: WordStatus) => void
}) {
  const t = useTranslation()
  const disabled = answer !== null
  const label = (status: WordStatus) =>
    status === 'known' ? t('quiz.know') : status === 'unsure' ? t('quiz.unsure') : t('quiz.new')

  return (
    <div className="flex justify-center gap-2">
      {ORDER.map((status) => (
        <button
          key={status}
          type="button"
          data-quiz-answer={status}
          aria-pressed={answer === status}
          disabled={status === 'known' ? knownDisabled : disabled}
          onClick={() => onAnswer(status)}
          className={`rounded-lg border px-5 py-2.5 text-sm transition disabled:opacity-30 ${
            answer === status ? 'border-accent text-ink' : 'border-line text-ink-muted hover:text-ink'
          }`}
        >
          {label(status)}
        </button>
      ))}
    </div>
  )
}
