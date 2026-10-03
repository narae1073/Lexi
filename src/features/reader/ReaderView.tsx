import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useOccurrencesStore } from '../../app/stores/occurrences'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { statusClass } from '../../lib/color'
import { DEFINITION_LANGUAGE } from '../../lib/languages'
import type { Document, Segment, Sentence } from '../../types'
import { sentencesInRange } from './selection'
import { SentencePopover } from './SentencePopover'
import { resolveLemmasFromWords } from './surfaceLemma'
import { isSentenceInitial, segmentAt, tokenize } from './tokenizer'
import { WordPopover } from './WordPopover'

type WordSegment = Extract<Segment, { type: 'word' }>

type Selection =
  | { kind: 'word'; segment: WordSegment; anchor: HTMLElement }
  | { kind: 'sentence'; sentences: Sentence[]; anchor: HTMLElement }

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

  /** 세그먼트를 감싸는 요소. 팝오버 앵커로 쓴다. */
  const anchorFor = (node: Node | null): HTMLElement | null => {
    const el = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node) as HTMLElement | null
    return el?.closest<HTMLElement>('[data-start]') ?? null
  }

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
   * 드래그로 문장을 고르는 경로 (plan.txt 6줄).
   * 선택이 안 된(단순 클릭) 상태면 단어 팝오버를 그대로 둔다.
   */
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

    const container = containerRef.current
    if (!container) return

    const range = sel.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return

    // 컨테이너의 텍스트는 원문과 문자 단위로 같으므로,
    // 시작점까지의 Range 길이가 곧 원문 문자 오프셋이다.
    const prefix = document.createRange()
    prefix.selectNodeContents(container)
    prefix.setEnd(range.startContainer, range.startOffset)

    const start = prefix.toString().length
    const end = start + range.toString().length
    if (end <= start) return

    const indexes = sentencesInRange(sentences, { start, end })
    if (indexes.length === 0) return

    const anchor = anchorFor(range.startContainer)
    if (!anchor) return

    setSelection({
      kind: 'sentence',
      sentences: sentences.filter((s) => indexes.includes(s.index)),
      anchor,
    })
  }, [sentences])

  return (
    <article className="mx-auto w-full max-w-2xl px-5 py-8">
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

      <div
        ref={containerRef}
        onClick={handleClick}
        onMouseUp={handleMouseUp}
        className="text-[1.05rem] leading-[2.1] break-words whitespace-pre-wrap"
      >
        {segments.map((segment) =>
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

      {selection?.kind === 'word' && (
        <WordPopover
          segment={selection.segment}
          lemma={lemmaFor(selection.segment)}
          languageCode={doc.languageCode}
          anchor={selection.anchor}
          onClose={() => setSelection(null)}
        />
      )}

      {selection?.kind === 'sentence' && (
        <SentencePopover
          sentences={selection.sentences}
          languageCode={doc.languageCode}
          targetLanguage={DEFINITION_LANGUAGE}
          anchor={selection.anchor}
          onClose={() => setSelection(null)}
        />
      )}
    </article>
  )
}