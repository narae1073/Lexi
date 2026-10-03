import { useEffect, useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import {
  DictionaryError,
  useDictionaryStore,
  type DictionaryEntry,
  type DictionarySection,
} from '../../lib/api/dictionary'
import type { LanguageCode } from '../../types'

type Outcome = { requestKey: string; status?: number }

/**
 * 사전 결과 (plan.txt 3줄의 사전 버튼).
 * 뜻은 영어로 온다 — 배울 언어가 영어가 아니어도 동일하다.
 *
 * 활용형 표기를 클릭하면 표기 항목과 기본형 항목을 함께 보여준다
 * (예: running 항목 + run 기본형 뜻·예문).
 */
export function DictionaryPanel({
  languageCode,
  lemma,
  surface,
}: {
  languageCode: LanguageCode
  lemma: string
  surface: string
}) {
  const t = useTranslation()
  const requestKey = `${languageCode}::${lemma}`
  const cachedEntry = useDictionaryStore((s) => s.entries[requestKey])
  const lookup = useDictionaryStore((s) => s.lookup)

  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    if (cachedEntry) return
    let cancelled = false

    lookup(languageCode, lemma, surface).catch((error: unknown) => {
      if (cancelled) return
      setOutcome({
        requestKey,
        status: error instanceof DictionaryError ? error.status : undefined,
      })
    })

    return () => {
      cancelled = true
    }
  }, [requestKey, languageCode, lemma, surface, cachedEntry, lookup])

  const entry: DictionaryEntry | undefined = cachedEntry
  // effect 안에서 동기 setState 를 하지 않는다 — 결과 키가 다르면 아직 없는 상태로 본다
  const failure = outcome?.requestKey === requestKey ? outcome : null

  if (failure) {
    return (
      <p className="text-status-unknown py-1 text-xs">
        {failure.status
          ? t('dictionary.failedStatus', { status: failure.status })
          : t('dictionary.failed')}
      </p>
    )
  }

  if (!entry) return <p className="text-ink-muted py-1 text-xs">{t('dictionary.loading')}</p>

  const sections = entry.sections.filter((section) => section.parts.length > 0)

  if (!entry.found || sections.length === 0) {
    return (
      <p className="text-ink-muted py-1 text-xs">{t('dictionary.notFound', { word: surface })}</p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {sections.map((section, index) => (
        <SectionView
          key={`${section.role}:${section.form}`}
          section={section}
          divider={index > 0}
        />
      ))}
    </div>
  )
}

function SectionView({
  section,
  divider,
}: {
  section: DictionarySection
  /** 두 번째 섹션부터 구분선을 그어 어느 항목인지 알 수 있게 한다 */
  divider: boolean
}) {
  const t = useTranslation()

  return (
    <section className="flex flex-col gap-1">
      <header className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold">{section.form}</span>
        {section.role === 'base' && (
          <span className="text-accent text-[10px] font-medium">{t('dictionary.baseForm')}</span>
        )}
        {section.phonetics.length > 0 && (
          <span className="text-ink-muted font-mono text-[10px]">{section.phonetics[0]}</span>
        )}
      </header>

      <div className="flex flex-col gap-1.5">
        {/* 위키낱말은 같은 품사를 여러 항목으로 주���다(en/run = verb 2개).
            품사만 key 로 쓰면 충돌해 뜻이 누락된다. */}
        {section.parts.map((part, partIndex) => (
          <div key={`${part.partOfSpeech}:${partIndex}`}>
            {part.partOfSpeech && (
              <p className="text-ink-muted mb-0.5 text-[10px] italic">{part.partOfSpeech}</p>
            )}
            <ol className="flex flex-col gap-1">
              {part.senses.map((sense, i) => (
                <li key={i}>
                  <p className="text-xs leading-snug">
                    <span className="text-ink-muted mr-1">{i + 1}.</span>
                    {sense.definition}
                    {sense.tags.length > 0 && (
                      <span className="text-ink-muted ml-1 text-[10px]">
                        ({sense.tags.join(', ')})
                      </span>
                    )}
                  </p>
                  {sense.examples.map((example, j) => (
                    <p
                      key={j}
                      className="text-ink-muted mt-0.5 pl-4 text-[10px] leading-relaxed italic"
                    >
                      {example}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      {/* CC BY-SA 4.0 — 출처 표기는 의무다. 섹션마다 다른 위키낱말 페이지다. */}
      <a
        href={section.source.url}
        target="_blank"
        rel="noreferrer noopener"
        className={`text-ink-muted pointer-events-auto text-[10px] underline ${
          divider ? 'border-line border-t pt-1.5' : ''
        }`}
      >
        {t('dictionary.source', { license: section.source.license })}
      </a>
    </section>
  )
}