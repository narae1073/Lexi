import { useSyncExternalStore } from 'react'

import { historyLines, lines } from './selectionDebug'

/**
 * 선택 진단 패널 — `?debug=select` 일 때만 뜬다.
 *
 * 폰에서는 개발자 도구를 열기 어렵다. 그래서 화면에 직접 띄워서,
 * "드래그했는데 뭐가 떴는지" 를 그대로 옮겨 쓸 수 있게 한다.
 */
export function SelectionDebugPanel() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => lines().join('\n'),
    () => '',
  )
  const history = useSyncExternalStore(
    subscribe,
    () => historyLines().join('\n'),
    () => '',
  )

  return (
    <section className="bg-surface border-status-unknown fixed inset-x-0 top-0 z-50 max-h-[60vh] overflow-auto border-b-2 p-2 font-mono text-[10px] leading-tight">
      <p className="text-status-unknown mb-1 font-sans text-xs font-semibold">
        선택 진단 — 캡처해서 보내주세요
      </p>
      <pre className="whitespace-pre-wrap">{snapshot}</pre>
      <details className="mt-1">
        <summary className="font-sans">최근 기록</summary>
        <pre className="whitespace-pre-wrap">{history}</pre>
      </details>
    </section>
  )
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    subtree: true,
    characterData: true,
    childList: true,
  })
  const timer = window.setInterval(onChange, 700)
  return () => {
    observer.disconnect()
    window.clearInterval(timer)
  }
}
