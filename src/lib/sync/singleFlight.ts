/**
 * 한 번에 하나만 — 동기화가 겹치지 않게.
 *
 * 겹치면 같은 데이터를 두 번 읽고, 같은 행을 두 번 쓰고, 밀린 개수를 두 번 뺀다.
 * 실행 중에 들어온 요청은 버리지 않는다 — 끝난 뒤 한 번 더 돈다 (그 사이에 바뀐
 * 것이 있을 수 있으므로).
 *
 * `run` 은 스스로 실패를 삼키는 함수여야 한다. 여기서는 오류를 해석하지 않고
 * 그대로 호출자에게 넘긴다.
 */
export type SingleFlight = (() => Promise<void>) & { whenIdle(): Promise<void> }

export function createSingleFlight(run: () => Promise<void>): SingleFlight {
  let inFlight: Promise<void> | null = null
  let rerun = false

  const invoke = (): Promise<void> => {
    if (inFlight) {
      rerun = true
      return inFlight
    }

    inFlight = (async () => {
      try {
        await run()
      } finally {
        inFlight = null
        if (rerun) {
          rerun = false
          void invoke()
        }
      }
    })()

    return inFlight
  }

  const singleFlight = invoke as SingleFlight
  singleFlight.whenIdle = async () => {
    while (inFlight || rerun) {
      const current = inFlight
      if (current) await current.catch(() => undefined)
    }
  }

  return singleFlight
}
