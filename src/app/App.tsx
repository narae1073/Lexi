import { useEffect } from 'react'
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'

import { ComposeDocument } from '../features/reader/ComposeDocument'
import { DocumentList } from '../features/reader/DocumentList'
import { ReaderView } from '../features/reader/ReaderView'
import { LanguagePicker } from '../features/languages/LanguagePicker'
import { AppLanguageSwitcher } from '../features/settings/AppLanguageSwitcher'
import { SettingsPanel } from '../features/settings/SettingsPanel'
import { Wordbook } from '../features/wordbook/Wordbook'
import { useDocumentsStore } from './stores/documents'
import { useLanguagesStore } from './stores/languages'
import { useOccurrencesStore } from './stores/occurrences'
import { useApplyTheme, useTranslation } from './stores/settings'

function DocumentReader({ id }: { id: string }) {
  const doc = useDocumentsStore((s) => s.documents.find((d) => d.id === id))
  if (!doc) return <Navigate to="/" replace />
  return <ReaderView doc={doc} />
}

function DocumentRoute() {
  const { id = '' } = useParams()
  return <DocumentReader id={id} />
}

function Nav() {
  const t = useTranslation()
  return (
    <nav className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-2xl items-center gap-3 overflow-x-auto px-5 py-3 whitespace-nowrap sm:gap-4">
        <Link to="/" className="text-sm font-semibold whitespace-nowrap">
          {t('appName')}
        </Link>
        <Link to="/languages" className="text-ink-muted hover:text-ink text-sm whitespace-nowrap">
          {t('nav.languages')}
        </Link>
        <Link to="/compose" className="text-ink-muted hover:text-ink text-sm whitespace-nowrap">
          {t('nav.compose')}
        </Link>
        <Link to="/wordbook" className="text-ink-muted hover:text-ink text-sm whitespace-nowrap">
          {t('nav.wordbook')}
        </Link>
        <Link to="/settings" className="text-ink-muted hover:text-ink text-sm whitespace-nowrap">
          {t('nav.settings')}
        </Link>
        <span className="ml-auto" />
        <AppLanguageSwitcher compact />
      </div>
    </nav>
  )
}

export default function App() {
  useApplyTheme()
  const t = useTranslation()
  const ready = useLanguagesStore((s) => s.ready)
  const load = useDocumentsStore((s) => s.load)
  const documents = useDocumentsStore((s) => s.documents)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  const loadOccurrences = useOccurrencesStore((s) => s.loadLanguage)
  const enrolled = useLanguagesStore((s) => s.enrolled)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    for (const language of enrolled) void loadOccurrences(language)
  }, [enrolled, loadOccurrences])

  // 온보딩 완료 전에는 언어 선택 화면으로 보낸다 (plan.txt 5줄)
  if (!ready) return <LanguagePicker />

  return (
    <div className="min-h-full">
      <Nav />
      <Routes>
        <Route path="/" element={documents.length === 0 ? <ComposeDocument /> : <DocumentList />} />
        <Route path="/languages" element={<LanguagePicker onDone={() => history.back()} />} />
        <Route path="/compose" element={<ComposeDocument />} />
        <Route path="/wordbook" element={<Wordbook />} />
        <Route path="/settings" element={<SettingsPanel />} />
        <Route path="/read/:id" element={<DocumentRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {needRefresh && (
        <button
          type="button"
          onClick={() => void updateServiceWorker(true)}
          className="fixed right-4 bottom-4 rounded-lg bg-accent px-4 py-2 text-sm text-accent-ink shadow-lg"
        >
          {t('sentence.retry')}
        </button>
      )}
    </div>
  )
}