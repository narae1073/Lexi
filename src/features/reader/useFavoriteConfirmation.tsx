import { useState, type ReactNode } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { useWordStatesStore, wordKey } from '../../app/stores/wordStates'
import type { LanguageCode } from '../../types'
import { ConfirmDialog } from './ConfirmDialog'

export type FavoriteTarget = {
  languageCode: LanguageCode
  lemma: string
  surface: string
}

/**
 * Favorite toggles are immediate when adding, but ask before removing.
 *
 * The pending confirmation is local to the surface that opened it. That avoids
 * leaving a ghost dialog behind after navigation or an account change.
 */
export function useFavoriteConfirmation(): {
  requestToggle: (target: FavoriteTarget, favorite: boolean) => void
  confirming: boolean
  dialog: ReactNode
} {
  const t = useTranslation()
  const toggleFavorite = useWordStatesStore((s) => s.toggleFavorite)
  const [pending, setPending] = useState<FavoriteTarget | null>(null)

  const requestToggle = (target: FavoriteTarget, favorite: boolean) => {
    if (!favorite) {
      toggleFavorite(target.languageCode, target.lemma, target.surface)
      return
    }
    setPending(target)
  }

  const close = () => setPending(null)

  const confirm = () => {
    if (!pending) return
    const current = useWordStatesStore.getState().byKey[
      wordKey(pending.languageCode, pending.lemma)
    ]?.favorite
    // A sync or another surface may have removed it while this dialog was open.
    // In that case confirming should never accidentally add it back.
    if (current) {
      toggleFavorite(pending.languageCode, pending.lemma, pending.surface)
    }
    setPending(null)
  }

  return {
    requestToggle,
    confirming: pending !== null,
    dialog: pending ? (
      <ConfirmDialog
        title={t('favorite.confirmRemoveTitle')}
        body={t('favorite.confirmRemoveBody', { word: pending.surface })}
        confirmLabel={t('favorite.confirmRemove')}
        onConfirm={confirm}
        onClose={close}
      />
    ) : null,
  }
}
