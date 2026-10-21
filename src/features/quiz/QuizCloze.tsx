import { useTranslation } from '../../app/stores/settings'

/**
 * 앎 단어 복습 — 예문의 빈칸을 채우는 문제.
 *
 * 단어를 보여 주지 않고 문맥만 준다. 답을 누른 뒤에 단어·뜻·온전한 문장이
 * 공개된다. 번역은 답하기 전에 보여 주지 않는다 — 번역문에 답이 들어 있을 수
 * 있기 때문이다 (번역은 답한 뒤 QuizSentence 가 맡는다).
 */
export function QuizCloze({ text }: { text: string }) {
  const t = useTranslation()
  return (
    <div data-quiz-cloze className="border-line mt-10 rounded-xl border px-4 py-5">
      <p className="text-ink-muted mb-2 text-xs">{t('quiz.clozeHint')}</p>
      <p className="text-lg leading-relaxed">{text}</p>
    </div>
  )
}
