import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useTranslation } from '../../app/stores/settings'
import { ConfirmDialog } from './ConfirmDialog'
import { trashedDocuments } from './documentSort'

/**
 * 휴지통.
 *
 * 여기서 지우면 돌아올 수 없다 — 그래서 '되살리기' 를 기본 동��으로 두고,
 * 완전 삭제는 눈에 띄지 않게 두었다. 완전 삭제를 누르면 기록까지 함께 사라진다.
 */
export function TrashView() {
  const t = useTranslation()
  const documents = useDocumentsStore((s) => s.documents)
  const restore = useDocumentsStore((s) => s.restore)
  const purge = useDocumentsStore((s) => s.purge)

  const trashed = useMemo(() => trashedDocuments(documents), [documents])

  /** 완전히 지우기 전에 한 번 묻는 문서 — 단어 기록까지 사라지므로 */
  const [confirmingPurgeId, setConfirmingPurgeId] = useState<string | null>(null)

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-8">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t('trash.title')}</h1>
        <Link to="/" className="text-ink-muted text-sm hover:text-ink">
          {t('trash.close')}
        </Link>
      </header>

      {trashed.length === 0 ? (
        <p className="text-ink-muted text-sm">{t('trash.empty')}</p>
      ) : (
        <>
          <p className="text-ink-muted mb-4 text-xs">{t('trash.hint')}</p>
          <ul className="divide-y divide-line">
            {trashed.map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 py-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{doc.title}</span>
                  <span className="text-ink-muted text-xs">
                    {t('trash.deletedAt', {
                      date: doc.deletedAt ? new Date(doc.deletedAt).toLocaleString() : '',
                    })}
                  </span>
                </span>

                <button
                  type="button"
                  onClick={() => void restore(doc.id)}
                  className="border-accent text-accent shrink-0 rounded-lg border px-3 py-1.5 text-sm"
                >
                  {t('trash.restore')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingPurgeId(doc.id)}
                  className="text-ink-muted hover:text-status-unknown shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  {t('trash.purge')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {confirmingPurgeId && (
        <ConfirmDialog
          title={t('trash.confirmPurgeTitle')}
          body={t('trash.confirmPurgeBody')}
          confirmLabel={t('trash.purge')}
          onConfirm={() => {
            void purge(confirmingPurgeId)
            setConfirmingPurgeId(null)
          }}
          onClose={() => setConfirmingPurgeId(null)}
        />
      )}
    </section>
  )
}