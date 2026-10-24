import { useState } from 'react'

import { useLanguagesStore } from '../../app/stores/languages'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { SUPPORTED_LANGUAGES } from '../../lib/languages'
import { seedFirstRunStories } from '../onboarding/firstRun'
import { AppLanguageSwitcher } from '../settings/AppLanguageSwitcher'

/**
 * 배울 언어를 고르는 화면 (plan.txt 5줄).
 * 사전이 지원하는 전체 언어를 넣지 않고 화이트리스트만 노출한다.
 *
 * **여러 개를 한 번에 고른다.** 한 개를 고르는 순간 다음 화면으로 넘어가면 고르는
 * 중에도 저장이 되므로 — 첫 화면에서 하나를 눌렀다 계단식으로 튕겨 나가게 된다.
 * 그래서 마칠 때를 누른다.
 *
 * **내가 배우는 언어 / 배우지 않는 언어** 로 나눈다. 지금 무엇을 배우는지 한눈에
 * 들어야 어떤 것을 더 배울지 고를 수 있다 — 한 목록에 섞이면 지금 하는 것과 새로
 * 고르는 것이 구분되지 않는다.
 */
export function LanguagePicker({ onDone }: { onDone?: () => void }) {
  const t = useTranslation()
  const enrolled = useLanguagesStore((s) => s.enrolled)
  const ready = useLanguagesStore((s) => s.ready)
  const finish = useLanguagesStore((s) => s.finish)

  const mine = SUPPORTED_LANGUAGES.filter((lang) => enrolled.includes(lang.code))
  const others = SUPPORTED_LANGUAGES.filter((lang) => !enrolled.includes(lang.code))
  const [starting, setStarting] = useState(false)

  /** 첫 화면에서는 마치는 버튼이 항상 있어야 한다 — 어디서 끝낼지 있어야 한다 */
  const showDone = Boolean(onDone) || !ready

  /**
   * First-run stories are local IndexedDB writes. Await them before flipping
   * `ready` so Home never flashes the empty composer and then swaps in stories.
   * Existing libraries are skipped inside seedFirstRunStories.
   */
  const complete = async () => {
    if (starting) return
    setStarting(true)
    try {
      if (!ready) await seedFirstRunStories(enrolled)
    } catch (error) {
      // A storage failure must not trap the user in onboarding.
      console.error('첫 실행 이야기 준비 실패', error)
    } finally {
      const finished = finish()
      setStarting(false)
      if (finished) onDone?.()
    }
  }

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t('onboarding.title')}</h1>
          <p className="text-ink-muted mt-1 text-sm">{t('onboarding.hint')}</p>
        </div>
        <AppLanguageSwitcher />
      </div>

      {/* 지금 배우는 언어 — 비어 있으면 이 섹션 자체가 없다. 빈 제목을 남기면
          '아무것도 없다' 와 '아직 안 골랐다' 가 구분되지 않는다 */}
      {mine.length > 0 && (
        <section className="mb-6">
          <h2 className="text-ink-muted mb-2 text-xs font-medium">{t('langs.mine')}</h2>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {mine.map((lang) => (
              <LanguageButton key={lang.code} code={lang.code} label={lang.nativeLabel} active />
            ))}
          </ul>
        </section>
      )}

      <section>
        {mine.length > 0 && (
          <h2 className="text-ink-muted mb-2 text-xs font-medium">{t('langs.others')}</h2>
        )}
        {others.length === 0 ? (
          <p className="text-ink-muted text-sm">{t('langs.all')}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {others.map((lang) => (
              <LanguageButton key={lang.code} code={lang.code} label={lang.nativeLabel} active={false} />
            ))}
          </ul>
        )}
      </section>

      {showDone && (
        <button
          type="button"
          onClick={() => void complete()}
          disabled={enrolled.length === 0 || starting}
          aria-busy={starting}
          className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink disabled:opacity-30"
        >
          {starting
            ? t('onboarding.preparing')
            : enrolled.length === 0
              ? t('onboarding.selectAtLeastOne')
              : t('onboarding.doneCount', { count: enrolled.length })}
        </button>
      )}
    </section>
  )
}

function LanguageButton({
  code,
  label,
  active,
}: {
  code: (typeof SUPPORTED_LANGUAGES)[number]['code']
  label: string
  active: boolean
}) {
  const languageName = useLanguageName()
  const toggle = useLanguagesStore((s) => s.toggle)

  return (
    <li>
      <button
        type="button"
        onClick={() => toggle(code)}
        aria-pressed={active}
        className={`flex w-full flex-col gap-0.5 rounded-xl border px-4 py-3 text-left transition ${
          active
            ? 'border-accent bg-accent text-accent-ink'
            : 'border-line bg-surface hover:border-line'
        }`}
      >
        <span className="text-sm font-medium">{languageName(code)}</span>
        {/*
          선택된 카드의 바탕은 강조색이다 — 표면용 옅은 글자색을 그대로 쓰면 묻힌다.
          선택 상태에서는 강조색 위의 글자색을 쓴다. 테마마다 강조색 위 글자색을
          따로 정해 두었으므로 모든 테마에서 읽힌다.
        */}
        <span className={`text-xs ${active ? 'text-accent-ink' : 'text-ink-muted'}`}>{label}</span>
      </button>
    </li>
  )
}
