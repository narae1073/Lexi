import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useOccurrencesStore } from '../../app/stores/occurrences'
import { useWordStatesStore } from '../../app/stores/wordStates'
import {
  useLanguageName,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'
import { statusClass } from '../../lib/color'
import { DEFINITION_LANGUAGE } from '../../lib/languages'
import type { Document, Segment, Sentence, WordStatus } from '../../types'
import type { Page } from '../../lib/paginate'
import { isOnPage, pageWordsOrDefault, planPages, READER_PAGE_WORDS } from './pageBreak'
import { Pagination } from '../wordbook/Pagination'
import { sentencesInRange } from './selection'
import { SentencePopover } from './SentencePopover'
import { resolveLemmasFromWords } from './surfaceLemma'
import { anchorForRange } from './anchor'
import { isSentenceInitial, segmentAt, tokenize } from './tokenizer'
import { StatusBar, type DocumentStats } from './StatusBar'
import { WordPopover } from './WordPopover'

type WordSegment = Extract<Segment, { type: 'word' }>

/**
 * 선택이 멈추었다고 보고할 때까지의 시간.
 *
 * 손가락으로 끌 때는 selectionchange 가 계속 울린다. 끝날 때까지 기다리면
 * 손을 뗄 때마다 팝오버가 깜빡이고, 기다리지 않으면 드래그 도중에 떠서
 * 원래 고른 자리를 가린다.
 */
const SELECTION_SETTLE_MS = 220

type Selection =
  | { kind: 'word'; segment: WordSegment; anchor: HTMLElement }
  /**
   * `backTo` 는 단어 팝오버에서 건너온 경로다.
   * 문장 번역 창을 닫으면 원래 단어 팝오버로 돌아가야 한다 — 닫아 버리면
   * 상태를 고치러 왔던 사용자가 길을 잃는다.
   */
  | {
      kind: 'sentence'
      sentences: Sentence[]
      anchor: HTMLElement
      backTo?: { kind: 'word'; segment: WordSegment; anchor: HTMLElement }
    }

/**
 * 문서를 단어 단위로 렌더링한다.
 *
 * 세그먼트가 원문 전체를 빈틈없이 덮으므로 그냥 이어 붙여도 글자가 빠지지 않는다.
 * 단어 클릭 → 상태 팝오버, 문장 드래그 → 번역 팝오버 (plan.txt 3·6줄).
 */
export function ReaderView({ doc }: { doc: Document }) {
  const t = useTranslation()
  const languageName = useLanguageName()

  const { segments, sentences } = useMemo(
    () => tokenize(doc.rawText, doc.languageCode),
    [doc.rawText, doc.languageCode],
  )

  const byKey = useWordStatesStore((s) => s.byKey)
  const loadWordStates = useWordStatesStore((s) => s.loadLanguage)
  const recordOccurrences = useOccurrencesStore((s) => s.recordDocument)
  const [selection, setSelection] = useState<Selection | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const pageWords = useSettingsStore((s) => s.readerPageWords)
  const setPageWords = useSettingsStore((s) => s.setReaderPageWords)
  const [pageIndex, setPageIndex] = useState(0)
  const retryTimer = useRef(0)
  const settleTimer = useRef(0)

  /**
   * 표기 → lemma 매핑.
   * 소문자만 접으면 us(대명사) 와 US(국가) 가 한 상태로 합쳐지므로,
   * 문서 안에서 실제 쓰인 표기를 보고 결정한다 (surfaceLemma.ts).
   */
  const lemmaOf = useMemo(() => {
    const words = segments.filter((s) => s.type === 'word')
    return resolveLemmasFromWords(
      words.map((w) => ({
        text: w.text,
        sentenceInitial: isSentenceInitial(doc.rawText, sentences, w.start, w.sentenceIndex),
      })),
    )
  }, [segments, sentences, doc.rawText])

  /** 세그먼트의 대표 lemma */
  const lemmaFor = useCallback(
    (segment: WordSegment) => lemmaOf.get(segment.text) ?? segment.lemma,
    [lemmaOf],
  )

  useEffect(() => {
    void loadWordStates(doc.languageCode)
  }, [doc.languageCode, loadWordStates])

  // 단어장에 필요한 등장 기록. 렌더를 막지 않도록 유휴 시점에 쓴다.
  useEffect(() => {
    const run = () => void recordOccurrences(doc)
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200))
    const handle = idle(run)
    return () => {
      if (typeof window.cancelIdleCallback === 'function' && typeof handle === 'number') {
        window.cancelIdleCallback(handle)
      }
    }
  }, [doc, recordOccurrences])

  const wordCount = useMemo(
    () => segments.reduce((n, s) => (s.type === 'word' ? n + 1 : n), 0),
    [segments],
  )

  /**
   * 쪽 배치 (plan.txt 7줄).
   *
   * 문장 경계에서만 자르되 오프셋은 원문 그대로 둔다. 그래야 어느 쪽에서
   * 단어를 눌러도 문장 번역을 눌러도 같은 오프셋을 쓰게 된다.
   */
  const pages = useMemo(
    () =>
      planPages(
        doc.rawText,
        sentences,
        sentences.map((sentence) =>
          segments.reduce(
            (n, s) => (s.type === 'word' && s.sentenceIndex === sentence.index ? n + 1 : n),
            0,
          ),
        ),
        pageWords,
      ),
    [doc.rawText, sentences, segments, pageWords],
  )

  // 다른 문서를 열었거나 쪽 크기를 줄여 쪽 수가 줄면 범위를 벗어난 쪽으로 가지 않는다
  const safePageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1))
  const page = pages[safePageIndex]

  const pageItems = useMemo(() => segments.filter((s) => isOnPage(s, page)), [segments, page])

  /** 쪽 이동 UI — 단어 수는 이 쪽이 덮는 구간을 보여준다 */
  const pageNav = useMemo<Page<unknown>>(
    () => ({
      items: [page],
      page: safePageIndex + 1,
      pageCount: pages.length,
      total: wordCount,
      pageSize: wordCount,
      from: page.from,
      to: page.to,
      hasPrev: safePageIndex > 0,
      hasNext: safePageIndex < pages.length - 1,
    }),
    [page, pages.length, safePageIndex, wordCount],
  )

  /**
   * 쪽을 옮긴다.
   *
   * 위에서 시작하고 열려 있던 팝오버를 닫는다 — 새 쪽에는 그 앵커가 없으므로
   * 닫지 않으면 엉뚱한 자리에 떠 있다. 사용자가 누른 결과라 그 자리에서 해도 된다.
   */
  const goToPage = useCallback((index: number) => {
    setPageIndex(index)
    setSelection(null)
    window.scrollTo({ top: 0 })
  }, [])

  /**
   * 상태 바 통계.
   *
   * 총합과 상태별 개수는 같은 기준이어야 한다 — 하나는 중복을 빼고 다른 하나는
   * 셀대로 세면 합이 영영 맞지 않아 화면이 거짓말을 한다.
   * 여기서는 전부 "중복을 뺀 서로 다른 단어" 로 센다.
   */
  const stats = useMemo<DocumentStats>(() => {
    // 한 단어의 상태는 전역이라 같은 lemma 은 어디서든 같은 값이다.
    // 한 번만 세면 된다.
    const byLemma = new Map<string, WordStatus | 'unmarked'>()
    for (const segment of segments) {
      if (segment.type !== 'word') continue
      const lemma = lemmaFor(segment)
      if (byLemma.has(lemma)) continue
      byLemma.set(lemma, byKey[`${doc.languageCode}::${lemma}`]?.status ?? 'unmarked')
    }

    const byStatus: DocumentStats['byStatus'] = { known: 0, unsure: 0, unknown: 0, unmarked: 0 }
    for (const status of byLemma.values()) byStatus[status] += 1

    return { uniqueWords: byLemma.size, occurrences: wordCount, byStatus }
  }, [segments, byKey, doc.languageCode, lemmaFor, wordCount])

  /**
   * 단어 클릭은 이벤트 대상에서 직접 찾는다.
   * Selection API에 기대면 앵커가 요소 경계에 놓였을 때 문자 오프셋을 못 읽고
   * 팝오버가 뜨지 않는다. 드래그 선택에서만 Selection 을 쓴다.
   */
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      // 드래그 선택 뒤에도 click 이 울린다. 그 click 이 문장 팝오버를 단어 팝오버로
      // 덮어쓰면 문장 번역이 열리자마자 사라진다.
      const selected = window.getSelection()
      if (selected && !selected.isCollapsed) return

      const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-start]')
      if (!el) {
        setSelection(null)
        return
      }

      const segment = segmentAt(segments, Number(el.dataset.start))
      if (segment?.type !== 'word') {
        setSelection(null)
        return
      }

      setSelection({ kind: 'word', segment, anchor: el })
    },
    [segments],
  )

  /**
   * 선택된 문장을 연다 (plan.txt 6줄).
   *
   * 신호는 'selectionchange' 다. 터치 기기에서는 손을 떼는 순(touchend)이나
   * scroll 로 넘어가는 순간(touchcancel)에 getSelection() 을 읽으면 아직 확정되지
   * 않은 값을 받는다. 그래서 폰에서는 아무 일도 일어나지 않았다 — 운영체제 기본
   * 선택 상자만 뜬다. 브라우저가 선택을 확정했다는 신호를 직접 듣는 것이 맞다.
   *
   * 'pending' = 선택은 있는데 앵커를 못 잡았다. 호출한 쪽이 조금 뒤에 다시 본다.
   */
  const readSelection = useCallback((): 'opened' | 'pending' | 'none' => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return 'none'

    const container = containerRef.current
    if (!container) return 'none'

    const range = sel.getRangeAt(0)

    /**
     * 선택이 본문과 닿는지.
     *
     * 손으로 끌면 선택이 컨테이너 밖(앞 문단의 끝이나 뒤 공백)까지 뻗을 수 있다.
     * 공통 조상이 컨테이너 안에 있을 때만 본다고 하면 그 경우를 놓친다.
     */
    const touches =
      container.contains(range.startContainer) ||
      container.contains(range.endContainer) ||
      container.contains(range.commonAncestorContainer)
    if (!touches) return 'none'

    // 시작점이 컨테이너 밖이면 오프셋을 셀 수 없다. 끝점으로 대신 잰다.
    const at = container.contains(range.startContainer) ? range.startContainer : range.endContainer
    const atOffset = container.contains(range.startContainer) ? range.startOffset : range.endOffset

    const prefix = document.createRange()
    prefix.selectNodeContents(container)
    try {
      prefix.setEnd(at, atOffset)
    } catch {
      return 'none'
    }

    // 컨테이너는 이 쪽 문장만 담고 있다. 여기서 얻은 오프셋은 쪽 기준이므로
    // 원문 기준으로 되돌려야 문장 번역이 맞는 문장을 찾는다.
    const start = page.start + prefix.toString().length
    const end = start + range.toString().length
    if (end <= start) return 'none'

    const indexes = sentencesInRange(sentences, { start, end })
    if (indexes.length === 0) return 'none'

    // 롱프레스는 선택이 요소 경계에서 시작하게 만든다. 앵커를 못 잡으면
    // 아무 일도 일어나지 않으므로, 오프셋을 보고 가장 가까운 단어까지 찾는다.
    const anchor = anchorForRange(range, start)
    if (!anchor) return 'pending'

    retryTimer.current = 0
    setSelection({
      kind: 'sentence',
      sentences: sentences.filter((s) => indexes.includes(s.index)),
      anchor,
    })
    return 'opened'
  }, [sentences, page.start])

  /** 데스크톱: 마우스를 떼는 즉시 반응해야 손맛이 맞는다 */
  const handleSelectionEnd = useCallback(() => {
    if (window.getSelection()?.isCollapsed) return
    settleTimer.current = 0
    if (readSelection() !== 'pending') return
    retryTimer.current = window.setTimeout(() => readSelection(), 80)
  }, [readSelection])

  /**
   * 터치: 브라우저가 선택을 확정했다는 신호를 듣는다.
   *
   * 끌고 있는 동안 계속 울리므로 기다렸다가 한 번만 본다. 마지막 신호로부터
   * 시간이 지나면 사용자가 손을 멈춘 것으로 본다.
   */
  useEffect(() => {
    const onSelectionChange = () => {
      if (!containerRef.current) return
      // 선택이 사라졌다(빈손 탭, ESC)는 아무것도 하지 않는다 — 단어 팝오버를 지우는 쪽이 따로 있다
      if (window.getSelection()?.isCollapsed) return
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(() => {
        if (readSelection() !== 'pending') return
        retryTimer.current = window.setTimeout(() => readSelection(), 80)
      }, SELECTION_SETTLE_MS)
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
      if (retryTimer.current) window.clearTimeout(retryTimer.current)
    }
  }, [readSelection])

  /**
   * 드래그 없이 문장을 번역하는 길 (plan.txt 6줄).
   *
   * 모바일에서는 드래그로 글자를 고르는 동작 자체가 까다롭다 — 롱프레스가
   * 브라우저의 선택 메뉴를 띄우고, 놓는 위치가 손가락 밑이라 자주 빗나간다.
   * 단어를 눌러 팝오버를 띄운 뒤 '이 문장 번역' 을 누르면 그 문장이 정확히
   * 어느 문장인지 알 필요도 없이 그 자리에서 시작한다.
   */
  const translateSentenceOf = useCallback(
    (segment: WordSegment, anchor: HTMLElement) => {
      const target = sentences.filter((sentence) => sentence.index === segment.sentenceIndex)
      if (target.length === 0) return
      setSelection({
        kind: 'sentence',
        sentences: target,
        anchor,
        backTo: { kind: 'word', segment, anchor },
      })
    },
    [sentences],
  )

  return (
    // 하단 상태 바가 본문을 가리지 않도록 여유를 둔다
    <article className="mx-auto w-full max-w-2xl px-5 pt-8 pb-32">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">{doc.title}</h1>
        <p className="text-ink-muted mt-1 text-xs">
          {languageName(doc.languageCode)} ·{' '}
          {t('reader.stats', { words: wordCount, sentences: sentences.length })}
        </p>
        {/* 문서 안에서도 단어장으로 갈 수 있다 — 이 문서의 단어만 (plan.txt 9줄) */}
        <Link
          to={`/wordbook?doc=${doc.id}&lang=${doc.languageCode}`}
          className="border-line text-ink-muted hover:text-ink hover:border-accent mt-2 inline-block rounded-lg border px-2.5 py-1 text-xs transition"
        >
          {t('reader.toWordbook')}
        </Link>
      </header>

      {/* 한 쪽에 몇 단어까지 담을지 — 몇 단어가 한 화면을 차지하는지 보고 고른다 */}
      <label className="text-ink-muted mb-3 flex items-center justify-end gap-1.5 text-xs">
        {t('pagination.readerSize')}
        <select
          value={pageWords}
          onChange={(event) => {
            setPageWords(pageWordsOrDefault(Number(event.target.value)))
            goToPage(0)
          }}
          className="border-line focus:border-accent rounded-lg border bg-surface px-2 py-1 text-sm outline-none"
        >
          {READER_PAGE_WORDS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>

      <div
        ref={containerRef}
        onClick={handleClick}
        /*
         * 데스크톱 드래그: 마우스를 떼는 순간 바로 연다.
         * 터치는 touchend 에 읽으면 아직 확정되지 않은 값을 받으므로
         * selectionchange 신호를 쓴다 — 이벤트를 기다리는 것만으로는
         * 폰에서 여는 것이 불가능했다.
         */
        onMouseUp={handleSelectionEnd}
        className="text-[1.05rem] leading-[2.1] break-words whitespace-pre-wrap"
      >
        {pageItems.map((segment) =>
          segment.type === 'word' ? (
            <span
              key={segment.start}
              data-start={segment.start}
              className={`cursor-pointer rounded-sm ${statusClass(
                byKey[`${doc.languageCode}::${lemmaFor(segment)}`]?.status,
              )}`}
            >
              {segment.text}
            </span>
          ) : (
            <span key={segment.start}>{segment.text}</span>
          ),
        )}
      </div>

      {pages.length > 1 && (
        <p className="text-ink-muted mt-6 text-center text-xs">
          {t('pagination.readerRange', { page: safePageIndex + 1, pageCount: pages.length })}
        </p>
      )}

      <Pagination page={pageNav} onPageChange={(n) => goToPage(n - 1)} />

      {selection?.kind === 'word' && (
        <WordPopover
          segment={selection.segment}
          lemma={lemmaFor(selection.segment)}
          languageCode={doc.languageCode}
          anchor={selection.anchor}
          onTranslateSentence={() => translateSentenceOf(selection.segment, selection.anchor)}
          onClose={() => setSelection(null)}
        />
      )}

      {selection?.kind === 'sentence' && (
        <SentencePopover
          sentences={selection.sentences}
          languageCode={doc.languageCode}
          targetLanguage={DEFINITION_LANGUAGE}
          anchor={selection.anchor}
          onClose={() =>
            // 단어 팝오버에서 건너온 경로는 그 자리로 되돌린다
            setSelection(
              selection.backTo ?? null,
            )
          }
        />
      )}

      <StatusBar stats={stats} />
    </article>
  )
}