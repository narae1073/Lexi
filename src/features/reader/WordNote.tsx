import { useId, useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import type { LanguageCode } from '../../types'

/**
 * 단어 메모 — 어원·연상·내 예문.
 *
 * 상태·별과 독립이다. 메모를 적는 것은 복습이 아니므로 lastSeenAt 을 건드리지
 * 않고, 자기 시각(noteUpdatedAt)으로만 기기 간에 겨룬다.
 */
export function WordNote({
  languageCode,
  lemma,
  surface,
}: {
  languageCode: LanguageCode
  lemma: string
  surface: string
}) {
  const t = useTranslation()
  const note = useWordStatesStore((s) => s.byKey[`${languageCode}::${lemma}`]?.note ?? '')
  const setNote = useWordStatesStore((s) => s.setNote)
  const [draft, setDraft] = useState(note)
  const id = useId()

  const dirty = draft !== note

  return (
    <div className="mt-2">
      <label htmlFor={id} className="text-ink-muted text-[10px]">
        {t('note.label')}
      </label>
      <textarea
        id={id}
        data-word-note
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t('note.placeholder')}
        rows={2}
        className="border-line bg-surface text-ink placeholder:text-ink-muted/60 pointer-events-auto mt-0.5 w-full resize-none rounded-lg border px-2 py-1 text-xs leading-snug"
      />
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          data-word-note-save
          disabled={!dirty}
          onClick={() => setNote(languageCode, lemma, draft, surface)}
          className="border-line text-ink-muted hover:text-ink hover:border-accent pointer-events-auto rounded border px-2 py-0.5 text-[10px] transition disabled:opacity-30"
        >
          {t('note.save')}
        </button>
      </div>
    </div>
  )
}
