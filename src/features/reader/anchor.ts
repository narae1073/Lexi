/**
 * 팝오버 앵커를 찾는 방법.
 *
 * 선택이 어디서 시작하느냐에 따라 range.startContainer 가 텍스트 노드일 수도
 * 있고 요소일 수도 있다. 터치 기기에서는 롱프레스 위치에 따라 선택이 정확히
 * 요소 경계에서 시작하는 일이 잦다.
 *
 * 예전 코드는 closest() 만 썼으므로, 시작점이 요소 경계면 앵커가 null 이 되어
 * 아무 일도 일어나지 않았다. 사용자에게는 "드래그가 먹지 않는다" 로 보인다.
 * 그래서 조상·자손·다음 형제 순으로 넓혀 찾는다.
 */

/** 단어 하나를 감싼 요소 */
const WORD_SELECTOR = '[data-start]'

function asElement(node: Node | null): Element | null {
  if (!node) return null
  if (node.nodeType === 1 /* ELEMENT_NODE */) return node as Element
  return node.parentElement
}

export function anchorForNode(node: Node | null): HTMLElement | null {
  const el = asElement(node)
  if (!el) return null

  // ① 조상 — 시작점이 단어 안의 텍스트 노드일 때
  const self = el.closest<HTMLElement>(WORD_SELECTOR)
  if (self) return self

  // ② 자손 — 시작점이 컨테이너 같은 큰 요소일 때
  const inner = el.querySelector<HTMLElement>(WORD_SELECTOR)
  if (inner) return inner

  // ③ 바로 다음 형제 — 시작점이 문장 끝의 공백 노드일 때
  let next: Element | null = el.nextElementSibling
  while (next) {
    const found = next.matches?.(WORD_SELECTOR)
      ? next
      : next.querySelector?.(WORD_SELECTOR)
    if (found) return found as HTMLElement
    next = next.nextElementSibling
  }

  return null
}

/**
 * 문자 오프셋이 들어 있는 단어 요소를 찾는다.
 *
 * 마지막 수단이다. 컨테이너의 첫 단어를 쓰면 선택과 상관없는 곳에 팝오버가
 * 떠서 혼란스러우므로, 선택 지점에 가장 가까운 단어를 고른다.
 */
export function anchorForOffset(container: HTMLElement, offset: number): HTMLElement | null {
  const words = [...container.querySelectorAll<HTMLElement>(WORD_SELECTOR)]
  if (words.length === 0) return null

  let best: HTMLElement | null = null
  for (const word of words) {
    const start = Number(word.dataset.start)
    if (Number.isNaN(start)) continue
    if (start <= offset) best = word
    else break
  }
  return best ?? words[0]
}

/**
 * 선택 구간의 앵커.
 *
 * 시작점을 먼저 보고, 그래도 없으면 끝점을 본다. 길게 끌 때 선택이 문장
 * 경계를 넘어 반대편 단어에서 시작할 수 있기 때문이다.
 */
export function anchorForRange(range: Range, offset?: number): HTMLElement | null {
  const fromStart = anchorForNode(range.startContainer)
  if (fromStart) return fromStart

  const fromEnd = anchorForNode(range.endContainer)
  if (fromEnd) return fromEnd

  if (offset === undefined) return null
  const el = asElement(range.commonAncestorContainer)
  if (!el || !('querySelectorAll' in el)) return null
  return anchorForOffset(el as HTMLElement, offset)
}
