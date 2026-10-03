import { Link } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useLanguageName, useTranslation } from '../../app/stores/settings'

export function DocumentList() {
  const t = useTranslation()
  const languageName = useLanguageName()
  const documents = useDocumentsStore((s) => s.documents)
  const loading = useDocumentsStore((s) => s.loading)

  if (loading) return <p className="p-8 text-sm text-ink-muted">{t('list.loading')}</p>
  if (documents.length === 0) return <p className="p-8 text-sm text-ink-muted">{t('list.empty')}</p>

  return (
    <ul className="divide-y divide-line">
      {documents.map((doc) => (
        <li key={doc.id}>
          <Link to={`/read/${doc.id}`} className="flex flex-col gap-0.5 px-5 py-3 hover:bg-surface-hover">
            <span className="text-sm font-medium">{doc.title}</span>
            <span className="text-ink-muted text-xs">
              {t('list.meta', {
                language: languageName(doc.languageCode),
                count: doc.rawText.trim().length,
                date: new Date(doc.updatedAt).toLocaleString(),
              })}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}