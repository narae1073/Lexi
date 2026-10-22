/**
 * Two tabs of the same origin must share storage and synchronize through
 * browser primitives. Task 0's S2 proved this works in the CDP harness; this
 * smoke keeps that capability honest.
 *
 * It does not drive an authenticated sync cycle — that needs a local Supabase
 * account and is covered by the unit tests. It checks the primitives the app
 * relies on: shared localStorage, BroadcastChannel, and the Web Lock used by
 * `withSyncLock`.
 */

function sleep(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function run(ctx) {
  const second = await ctx.openPage()
  await second.waitFor(
    'document.readyState === "complete" && typeof localStorage !== "undefined"',
    '두 번째 탭 로드',
  )

  // Same origin and profile share localStorage.
  await ctx.page.evaluate(`localStorage.setItem('lexi.tab-smoke', 'from-a')`)
  const shared = await second.page.evaluate(`localStorage.getItem('lexi.tab-smoke')`)
  ctx.check('두 탭이 localStorage 를 공유한다', shared === 'from-a', String(shared))

  // BroadcastChannel reaches the other tab on the same scope.
  const message = second.page.evaluate(`new Promise((resolve) => {
    const channel = new BroadcastChannel('lexi-sync-smoke')
    const timer = setTimeout(() => { channel.close(); resolve(null) }, 5000)
    channel.onmessage = (event) => {
      clearTimeout(timer)
      channel.close()
      resolve(event.data)
    }
  })`)
  await sleep(200)
  await ctx.page.evaluate(`(() => {
    const channel = new BroadcastChannel('lexi-sync-smoke')
    channel.postMessage('from-a')
    channel.close()
    return true
  })()`)
  ctx.check('BroadcastChannel 메시지가 다른 탭에 도착한다', (await message) === 'from-a')

  // A lock held by tab A must keep tab B queued until A releases it.
  const holding = ctx.page.evaluate(`(async () => {
    window.__lockOrder = []
    await navigator.locks.request('lexi-sync', async () => {
      window.__lockOrder.push('a:start')
      await new Promise((resolve) => { window.__releaseLock = resolve })
      window.__lockOrder.push('a:end')
    })
    return window.__lockOrder
  })()`)
  await ctx.waitFor('typeof window.__releaseLock === "function"', '첫 탭이 잠금을 잡음')

  const waiting = second.page.evaluate(`(async () => {
    await navigator.locks.request('lexi-sync', async () => {
      window.__bAcquired = true
    })
    return true
  })()`)
  await sleep(300)
  const acquiredEarly = await second.page.evaluate(`!!window.__bAcquired`)
  ctx.check('두 번째 탭은 첫 탭이 잠금을 쥐고 있는 동안 기다린다', acquiredEarly === false)

  await ctx.page.evaluate(`window.__releaseLock(); true`)
  await holding
  await waiting
  const acquiredLate = await second.page.evaluate(`!!window.__bAcquired`)
  ctx.check('첫 탭이 풀면 두 번째 탭이 잠금을 얻는다', acquiredLate === true)
}
