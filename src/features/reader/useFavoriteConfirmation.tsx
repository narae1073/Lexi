import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { useWordStatesStore, wordKey } from '../../app/stores/wordStates'
import type { LanguageCode } from '../../types'
import { Popover } from './Popover'

export type FavoriteTarget = {
  languageCode: LanguageCode
  lemma: string
  surface: string
  /** The star that was tapped; the compact confirmation anchors to it. */
  anchor: HTMLElement
}

/**
 * Favorite toggles are immediate when adding, but ask before removing.
 *
 * The pending confirmation is local to the surface that opened it and uses the
 * shared anchored Popover primitive. Unlike the old full-screen dialog, it
 * stays next to the star and leaves the page usable underneath.
 */
export function useFavoriteConfirmation(): {
  requestToggle: (target: FavoriteTarget, favorite: boolean) => void
  confirming: boolean
  confirmation: ReactNode
} {
  const t = useTranslation()
  const toggleFavorite = useWordStatesStore((s) => s.toggleFavorite)
  const [pending, setPending] = useState<FavoriteTarget | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (pending) cancelRef.current?.focus()
  }, [pending])

  const requestToggle = (target: FavoriteTarget, favorite: boolean) => {
    if (!favorite) {
      toggleFavorite(target.languageCode, target.lemma, target.surface)
      return
    }
    setPending(target)
  }

  const close = () => {
    const anchor = pending?.anchor
    setPending(null)
    // Return keyboard focus to the star when it is still mounted. On an
    // outside click the browser may move focus to the clicked element after
    // this pointerdown handler, which is the expected behavior.
    anchor?.focus()
  }

  const confirm = () => {
    if (!pending) return
    const current = useWordStatesStore.getState().byKey[
      wordKey(pending.languageCode, pending.lemma)
    ]?.favorite
    // A sync or another surface may have removed it while this popover was
    // open. In that case confirming should never accidentally add it back.
    if (current) {
      toggleFavorite(pending.languageCode, pending.lemma, pending.surface)
    }
    close()
  }

  return {
    requestToggle,
    confirming: pending !== null,
    confirmation: pending ? (
      <Popover
        anchor={pending.anchor}
        anchorKey={`favorite-confirm:${pending.languageCode}:${pending.lemma}:${pending.surface}`}
        onClose={close}
        width={236}
        ariaLabel={t('favorite.confirmRemoveTitle')}
      >
        <div data-favorite-confirm>
          <p className="text-xs font-semibold">{t('favorite.confirmRemoveTitle')}</p>
          <p className="text-ink-muted mt-1 text-[11px] leading-snug">
            {t('favorite.confirmRemoveBody', { word: pending.surface })}
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              ref={cancelRef}
              type="button"
              onClick={close}
              className="border-line text-ink-muted hover:text-ink hover:border-accent focus-visible:outline-accent pointer-events-auto rounded-md border px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t('confirm.cancel')}
            </button>
            <button
              type="button"
              onClick={confirm}
              className="border-status-unknown bg-status-unknown-bg text-status-unknown hover:bg-status-unknown-bg focus-visible:outline-accent rounded-md border px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t('favorite.confirmRemove')}
            </button>
          </div>
        </div>
      </Popover>
    ) : null,
  }
}
