import { useEffect, useMemo } from 'react'
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'

import { pruneCache } from '../lib/api/offlineCache'
import { ComposeDocument } from '../features/reader/ComposeDocument'
import { DocumentList } from '../features/reader/DocumentList'
import { ReaderView } from '../features/reader/ReaderView'
import { activeDocuments } from '../features/reader/documentSort'
import { TrashView } from '../features/reader/TrashView'
import { LanguagePicker } from '../features/languages/LanguagePicker'
import { AppLanguageSwitcher } from '../features/settings/AppLanguageSwitcher'
import { SettingsPanel } from '../features/settings/SettingsPanel'
import { SyncIndicator } from '../features/sync/SyncIndicator'
import { Wordbook } from '../features/wordbook/Wordbook'
import { useDocumentsStore } from './stores/documents'
import { useLanguagesStore } from './stores/languages'
import { useOccurrencesStore } from './stores/occurrences'
import { useCloudSync } from './stores/sync'
import { useWordStatesStore } from './stores/wordStates'
import { useApplyTextScale, useApplyTheme, useTranslation } from './stores/settings'

function DocumentReader({ id }: { id: string }) {
  const doc = useDocumentsStore((s) => s.documents.find((d) => d.id === id))
  const ready = useDocumentsStore((s) => s.ready)

  // 적재가 끝나기 전에 "없다" 고 판단하면 문서 URL 로 들어올 때마다 홈으로 튕긴다
  if (!ready) return null
  if (!doc) return <Navigate to="/" replace />
  // key 로 다시 그려야 문서를 바꿀 때 쪽·선택 상태가 함께 초기화된다
  return <ReaderView key={doc.id} doc={doc} />
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
        {/* 읽는 중에도 저장이 갔는지 보인다 — 설정 화면을 열지 않아도 된다 */}
        <SyncIndicator />
        <AppLanguageSwitcher compact />
      </div>
    </nav>
  )
}

export default function App() {
  useApplyTheme()
  useApplyTextScale()
  useCloudSync()
  const t = useTranslation()
  const ready = useLanguagesStore((s) => s.ready)
  const load = useDocumentsStore((s) => s.load)
  const allDocuments = useDocumentsStore((s) => s.documents)
  // 휴지통에 있는 문서는 목록에도 없으니 진도 계산도 필요 없다
  const documents = useMemo(() => activeDocuments(allDocuments), [allDocuments])
  const trashedCount = allDocuments.length - documents.length
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  const loadOccurrences = useOccurrencesStore((s) => s.loadLanguage)
  const refreshStaleDocuments = useOccurrencesStore((s) => s.refreshStaleDocuments)
  const loadWordStates = useWordStatesStore((s) => s.loadLanguage)
  const enrolled = useLanguagesStore((s) => s.enrolled)

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 목록의 진도 게이지를 위해, 아직 기록이 없는 문서를 유휴 시점에 계산한다.
   *
   * 등장 기록은 원문을 토크나이징해야 생긴다. 문서를 열 때만 하면 목록의 게이지가
   * 전부 비어 있고, '문서를 열어야만 보인다' 는 말과 같은 문제가 된다.
   * 계산은 기기 안에서만 일어나고 한 번 끝나면 다시 하지 않는다.
   */
  useEffect(() => {
    if (documents.length === 0) return
    const run = () => void refreshStaleDocuments(documents)
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300))
    const handle = idle(run)
    return () => {
      if (typeof window.cancelIdleCallback === 'function' && typeof handle === 'number') {
        window.cancelIdleCallback(handle)
      }
    }
  }, [documents, refreshStaleDocuments])

  // 번역·사전 응답은 기기에 계속 쌓인다. 오래된 것부터 한 번씩 버린다.
  useEffect(() => {
    void pruneCache()
  }, [])

  // 배운 언어의 등장 기록과 상태를 앱 시작 시 한 번에 적재한다.
  // 단어장은 문서를 열지 않아도 상태를 보여줘야 한다 (plan.txt 9줄).
  useEffect(() => {
    for (const language of enrolled) {
      void loadOccurrences(language)
      void loadWordStates(language)
    }
  }, [enrolled, loadOccurrences, loadWordStates])

  // 온보딩 완료 전에는 언어 선택 화면으로 보낸다 (plan.txt 5줄)
  if (!ready) return <LanguagePicker />

  return (
    <div className="min-h-full">
      <Nav />
      <Routes>
        {/* 첫 화면에서만 작성 화면을 내민다. 마지막 문서를 버린 뒤에는 목록을 보여야 한다 —
            빈 작성 화면만 남으면 버린 문서를 되돌릴 곳이 사라진다 */}
        <Route
          path="/"
          element={documents.length === 0 && trashedCount === 0 ? <ComposeDocument /> : <DocumentList />}
        />
        <Route path="/languages" element={<LanguagePicker onDone={() => history.back()} />} />
        <Route path="/compose" element={<ComposeDocument />} />
        <Route path="/wordbook" element={<Wordbook />} />
        <Route path="/trash" element={<TrashView />} />
      <Route path="/settings" element={<SettingsPanel />} />
        <Route path="/read/:id" element={<DocumentRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/*
        새 버전이 있다는 알림이다. "다시 시도" 라고 하면 무엇을 해야 하는지
        알 수 없으므로, 할 일을 그대로 말한다.
      */}
      {needRefresh && (
        <button
          type="button"
          onClick={() => void updateServiceWorker(true)}
          className="fixed right-4 bottom-20 rounded-lg bg-accent px-4 py-2 text-sm text-accent-ink shadow-lg"
        >
          {t('update.ready')}
        </button>
      )}
    </div>
  )
}