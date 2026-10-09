/**
 * 브라우저 검증 하네스.
 *
 * 헤드리스 크롬을 직접 띄워 CDP(Chrome DevTools Protocol) 로 구동한다.
 * 전용 테스트 러너 의존성 없이 Node 내장 WebSocket 만 쓴다.
 *
 *   node e2e/run-all.mjs            전체 실행
 *   node e2e/run-all.mjs word       이름이 word 를 포함하는 스펙만
 *
 * 왜 이게 필요한가: React key 충돌처럼 "조용히 실패하는" 버그가 실제로 있었고
 * 그때는 손으로 띄운 스크립트로만 찾았다. 스펙을 리포에 두어야 회귀를 막을 수 있다.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── CDP 클라이언트 ────────────────────────────────────────────────────────

class Page {
  #ws
  #id = 0
  #pending = new Map()
  logs = []

  static async open(wsUrl) {
    const page = new Page()
    page.#ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      page.#ws.onopen = resolve
      page.#ws.onerror = reject
    })
    page.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id && page.#pending.has(message.id)) {
        const { resolve, reject } = page.#pending.get(message.id)
        page.#pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails
        page.logs.push(`[exception] ${d.exception?.description ?? d.text}`)
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const type = message.params.type
        if (type === 'error' || type === 'warning') {
          const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
          page.logs.push(`[${type}] ${text}`)
        }
      }
    }
    return page
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id)
          reject(new Error(`${method} 시간 초과`))
        }
      }, 30_000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 실패')
    }
    return result.result?.value
  }

  close() {
    this.#ws.close()
  }
}

// ── 앱 조작 헬퍼 ──────────────────────────────────────────────────────────

const APP_ORIGIN = 'http://localhost:4173'

class Ctx {
  constructor(page, viewport) {
    this.page = page
    this.viewport = viewport
    this.results = []
  }

  async #eval(expression) {
    return this.page.evaluate(expression)
  }

  check(name, pass, detail = '') {
    this.results.push({ name, pass: Boolean(pass) })
    const mark = pass ? 'PASS' : 'FAIL'
    console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}`)
  }

  /** 조건이 만족될 때까지 대기. 실패하면 스펙이 중단된다. */
  async waitFor(expression, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.#eval(expression)) return true
      await sleep(200)
    }
    throw new Error(`대기 시간 초과: ${label}`)
  }

  async waitForGone(expression, label, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await this.#eval(expression))) return true
      await sleep(200)
    }
    throw new Error(`사라지지 않음: ${label}`)
  }

  async setViewport(width, height) {
    this.viewport = { width, height }
    await this.page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
    })
  }

  /** localStorage / IndexedDB 를 비워 첫 실행 상태로 되돌린다 */
  async resetOrigin() {
    await this.page.send('Storage.clearDataForOrigin', {
      origin: APP_ORIGIN,
      storageTypes: 'all',
    })
  }

  async goto() {
    await this.page.send('Page.navigate', { url: APP_ORIGIN })
    await sleep(300)
  }

  /** 새로고침 — IndexedDB 는 남고 메모리 상태만 사라진다 */
  /** 네트워크를 끊는다 — 오프라인 동작을 확인하려면 이것 없이는 불가능하다 */
  async goOffline(offline = true) {
    await this.page.send('Network.enable')
    await this.page.send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    })
  }

  /** 주소를 그대로 열 때의 origin (딥링크 확인용) */
  async navigateTo(path) {
    await this.page.send('Page.navigate', { url: `${APP_ORIGIN}${path}` })
    await sleep(400)
  }

  async reload() {
    await this.page.send('Page.reload')
    await sleep(400)
  }

  /** 온보딩을 통과해 언어 선택 화면을 띄운다 */
  async waitForOnboarding(label) {
    await this.waitFor(
      `!![...document.querySelectorAll('button')].find(x=>x.className.includes('rounded-xl'))`,
      `온보딩 (${label})`,
    )
  }

  async clickText(text) {
    return this.#eval(`(() => {
      const el = [...document.querySelectorAll('button, a')].find(x => x.innerText.trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click();
      return true;
    })()`)
  }

  async clickSelector(selector) {
    return this.#eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`)
  }

  /** 배울 언어를 골라 온보딩을 통과한다 (label 은 languages.ts 의 label) */
  /**
   * 언어를 골라 온보딩을 끝낸다.
   *
   * 언어를 하나 골라도 넘어가지 않는다 — 여러 개를 고를 수 있어야 하기 때문이다.
   * 그래서 '마치는' 버튼을 눌러야 한다. 고르는 동안에도 저장은 되므로 여기서
   * 넘어가지 않으면 첫 화면에서 계단식으로 튕겨 나간다.
   */
  async enrollLanguage(label) {
    await this.waitForOnboarding(label)
    const picked = await this.#eval(`(() => {
      const b = [...document.querySelectorAll('ul li button')].find(x =>
        x.innerText.includes(${JSON.stringify(label)}));
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!picked) throw new Error(`배울 언어 카드를 찾지 못함: ${label}`)
    await sleep(300)

    const done = await this.#eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x =>
        /Start with these|시작하기/.test(x.innerText));
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`)
    if (!done) throw new Error('온보딩을 마치는 버튼을 찾지 못함')
    await sleep(600)
  }

  /** 배울 언어를 추가로 등록하고 (온보딩이 이미 끝난 상태에서) */
  async addLanguage(label) {
    await this.clickSelector('a[href="/languages"]')
    await sleep(500)
    const picked = await this.#eval(`(() => {
      const b = [...document.querySelectorAll('ul li button')].find(x =>
        x.innerText.includes(${JSON.stringify(label)}));
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!picked) throw new Error(`언어 카드를 찾지 못함: ${label}`)
    await sleep(500)
  }

  async typeIntoTextarea(text) {
    const box = await this.#eval(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(20, r.height / 2) };
    })()`)
    if (!box) throw new Error('textarea 없음')
    // JS 로 value 를 대입하면 React 노드가 교체되는 타이밍에 밀린다.
    // 실제 클릭 + Input.insertText 로 입력 파이프라인을 그대로 태운다.
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.page.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    await sleep(150)
    // 기존 내용을 먼저 지운다 — insertText 는 커서 위치에 "삽입" 하므로
    // 앞선 입력값이 뒤에 붙어 테스트 데이터가 뒤섞인다.
    await this.page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 2, key: 'a', windowsVirtualKeyCode: 65,
    })
    await this.page.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 2, key: 'a', windowsVirtualKeyCode: 65,
    })
    await this.page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8,
    })
    await this.page.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8,
    })
    await sleep(100)
    await this.page.send('Input.insertText', { text })
    await sleep(500)
  }

  /** 단어를 실제 클릭 좌표로 누른다 */
  async clickWord(surface) {
    const box = await this.#eval(`(() => {
      const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === ${JSON.stringify(surface)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!box) return false
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.page.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    return true
  }

  /** 문장 드래그 선택 */
  async dragWords(fromSurface, toSurface) {
    const coords = await this.#eval(`(() => {
      const span = (w) => [...document.querySelectorAll('[data-start]')].find(e => e.textContent === w);
      const a = span(${JSON.stringify(fromSurface)});
      const b = span(${JSON.stringify(toSurface)});
      if (!a || !b) return null;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return {
        from: { x: ra.left + 1, y: ra.top + ra.height / 2 },
        to: { x: rb.right - 1, y: rb.top + rb.height / 2 },
      };
    })()`)
    if (!coords) throw new Error(`드래그 대상 단어 없음: ${fromSurface} → ${toSurface}`)

    await this.page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: coords.from.x,
      y: coords.from.y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      await this.page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        button: 'left',
        buttons: 1,
        x: coords.from.x + ((coords.to.x - coords.from.x) * i) / steps,
        y: coords.from.y + ((coords.to.y - coords.from.y) * i) / steps,
      })
    }
    await this.page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: coords.to.x,
      y: coords.to.y,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
  }

  /**
   * touchend 를 쏜다.
   *
   * 터치 기기에서 글자를 고르고 손을 떼면 touchend 가 mouseup 보다 먼저 온다.
   * 앱이 mouseup 만 듣고 있으면 반응하지 않는다 — 이 경로가 실제로 되는지 본다.
   */
  async touchEnd(selector) {
    return this.#eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const touch = new Touch({ identifier: 1, target: el, clientX: 12, clientY: 12 });
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [touch], touches: [] }));
      return true;
    })()`)
  }

  /** 손을 뗐다가 스크롤로 넘어가서 touchcancel 이 오는 경우 */
  async touchCancel(selector) {
    return this.#eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const touch = new Touch({ identifier: 1, target: el, clientX: 12, clientY: 12 });
      el.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, changedTouches: [touch], touches: [] }));
      return true;
    })()`)
  }

  async pressEscape() {
    await this.#eval(
      `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`,
    )
    await sleep(250)
  }

  /** 현재 열린 팝오버 내용. 없으면 null */
  /** 팝오버의 실제 자리 — 위아래로 넘치는지 보려면 좌표가 필요하다 */
  async popoverBox() {
    return this.#eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        width: Math.round(r.width),
        viewportHeight: innerHeight,
        visible: getComputedStyle(d).visibility === 'visible',
      };
    })()`)
  }

  async popover() {
    return this.#eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      return {
        text: d.innerText,
        width: Math.round(d.getBoundingClientRect().width),
        sections: d.querySelectorAll('section').length,
        forms: [...d.querySelectorAll('section span.font-semibold')].map(x => x.innerText),
        buttons: [...d.querySelectorAll('button')].map(b => b.innerText.trim()),
        visible: getComputedStyle(d).visibility === 'visible',
      };
    })()`)
  }

  /** 단어 상태 버튼을 누른다 (label 예: 'New' / '모름') */
  async setStatus(label) {
    const ok = await this.#eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return false;
      const b = [...d.querySelectorAll('button')].find(x => x.innerText.includes(${JSON.stringify(label)}));
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!ok) throw new Error(`상태 버튼을 찾지 못함: ${label}`)
    await sleep(300)
  }

  /**
   * 사전 버튼을 눌러 결과를 기다린다.
   * freedictionaryapi 가 가끔 응답이 없으므로 한 번 재시도한다 — 일시적 장애와
   * 실제 회귀를 구분하기 위해 스펙이 아니라 하네스에서 흡수한다.
   */
  async openDictionary({ retries = 1 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ok = await this.#eval(`(() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return false;
        const b = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === 'Dictionary');
        if (b) { b.click(); return true; }
        const hide = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === 'Hide');
        if (hide) hide.click();
        return false;
      })()`)
      if (ok) {
        // Edge Function 이 후보를 순차 조회해 upstream 지연이 누적되므로 generous 한 창이 필요하다
        const settled = await this.#waitDictionary(25_000)
        if (settled) {
          await sleep(300)
          return this.popover()
        }
      }
    }
    throw new Error('사전 결과가 도착하지 않음')
  }

  async #waitDictionary(timeoutMs) {
    try {
      await this.waitFor(
        `(() => { const d = document.querySelector('[role="dialog"]');
           if (!d) return false;
           const t = d.innerText;
            return !t.includes('Looking up') && (t.includes('Wiktionary') || t.includes('CC-CEDICT') || t.includes('No entry') || t.includes('Could not'));
         })()`,
        '사전 결과',
        timeoutMs,
      )
      return true
    } catch {
      return false
    }
  }

  /** 문서를 만든 뒤 읽기 화면까지 연다 */
  async createDocument(text, languageLabel) {
    if (languageLabel) {
      const ok = await this.#eval(`(() => {
        // 언어 칩에 국기가 붙어 "🇩🇪 German" 형태이므로 포함 매칭으로 찾는다
        const b = [...document.querySelectorAll('button')].find(x =>
          x.className.includes('rounded-lg') && x.innerText.includes(${JSON.stringify(languageLabel)}));
        if (!b) return false;
        b.click();
        return true;
      })()`)
      if (!ok) throw new Error(`문서 언어 칩을 찾지 못함: ${languageLabel}`)
      await sleep(300)
    }
    await this.typeIntoTextarea(text)
    await this.clickText('Create document')
    await sleep(700)
    await this.clickSelector('a[href="/"]')
    await sleep(500)
    await this.waitFor(`!![...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))`, '문서 목록')
    await this.#eval(
      `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/')).click(); true`,
    )
    await this.waitFor(`!!document.querySelector('[data-start]')`, '본문')
    await sleep(400)
  }

  async selectTheme(label) {
    const ok = await this.#eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(label)});
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!ok) throw new Error(`테마 버튼을 찾지 못함: ${label}`)
    await sleep(350)
  }

  /**
   * @param label 화면 표기 ('English' / '한국어')
   * @param short 내비게이션의 축약 코드 ('EN' / 'KO') — 라벨에서 유도할 수 없다
   */
  async setAppLanguage(label, short) {
    const ok = (await this.clickText(label)) || (short ? await this.clickText(short) : false)
    if (!ok) throw new Error(`앱 언어 버튼을 찾지 못함: ${label}`)
    await sleep(500)
  }

  /** IndexedDB 의 등장 기록을 읽는다 */
  async readOccurrences() {
    return this.#eval(`(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('lexi');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return await new Promise((res, rej) => {
        const t = db.transaction('wordOccurrences', 'readonly').objectStore('wordOccurrences').getAll();
        t.onsuccess = () => res(t.result);
        t.onerror = () => rej(t.error);
      });
    })()`)
  }

  /** 문서별 표기 규칙 버전 기록 */
  async readMeta() {
    return this.#eval(`(async () => {
      try {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('lexi');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (!db.objectStoreNames.contains('documentMeta')) return [];
        return await new Promise((res) => {
          const t = db.transaction('documentMeta', 'readonly');
          const r = t.objectStore('documentMeta').getAll();
          r.onsuccess = () => res(r.result);
        });
      } catch { return []; }
    })()`)
  }

  /** 규칙 버전 기록을 비운다 — 옛 규칙으로 계산된 것처럼 만들려고 */
  async wipeMeta() {
    return this.#eval(`(async () => {
      try {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('lexi');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (!db.objectStoreNames.contains('documentMeta')) return false;
        return await new Promise((res) => {
          const t = db.transaction('documentMeta', 'readwrite');
          const r = t.objectStore('documentMeta').clear();
          r.onsuccess = () => res(true);
        });
      } catch { return false; }
    })()`)
  }

  bodyText() {
    return this.#eval('document.body.innerText')
  }
}

// ── 프로세스 수명주기 ─────────────────────────────────────────────────────

/** 프로세스 그룹을 통째로 끝낸다 — 자식이 고아로 남으면 다음 실행에 포트가 걸린다 */
function killGroup(child) {
  if (!child?.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {}
    await sleep(250)
  }
  return false
}

export async function runAll(filter) {
  const specsDir = fileURLToPath(new URL('./specs', import.meta.url))
  const specFiles = readdirSync(specsDir)
    .filter((f) => f.endsWith('.spec.mjs'))
    .filter((f) => !filter || f.includes(filter))
    .sort()

  if (specFiles.length === 0) {
    console.error(`스펙을 찾지 못했습니다: ${filter ?? '(전체)'}`)
    return 1
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'lexi-e2e-'))
  const cdpPort = 9222 + Math.floor(Math.random() * 500)

  console.log('빌드 중…')
  await new Promise((resolve, reject) => {
    const build = spawn('npm', ['run', 'build'], { stdio: 'inherit' })
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('빌드 실패'))))
  })

  console.log('preview 서버 기동…')
  // detached 로 띄워서 프로세스 그룹째로 끝낸다.
  // npm 은 vite 를 자식 프로세스로 띄우므로, npm 만 죽이면 vite 가 고아로 남는다.
  // 실제로 한 번 실행했을 때 preview 프로세스 43개가 쌓였다.
  const server = spawn('npm', ['run', 'preview', '--', '--port', '4173'], {
    stdio: 'ignore',
    detached: true,
  })
  const killServer = () => killGroup(server)
  // Ctrl-C 로 끝내도 남지 않게 — 지금도 signal 경로가 없다
  process.once('exit', killServer)
  process.once('SIGINT', () => process.exit(130))
  process.once('SIGTERM', () => process.exit(143))

  if (!(await waitForHttp(APP_ORIGIN))) {
    killServer()
    console.error('preview 서버가 뜨지 않았습니다')
    return 1
  }

  console.log('헤드리스 크롬 기동…')
  const chrome = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let page
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const target = list.find((t) => t.type === 'page')
      if (target?.webSocketDebuggerUrl) {
        page = await Page.open(target.webSocketDebuggerUrl)
        break
      }
    } catch {}
    await sleep(250)
  }

  if (!page) {
    chrome.kill()
    killServer()
    console.error('크롬에 연결하지 못했습니다')
    return 1
  }

  await page.send('Page.enable')
  await page.send('Runtime.enable')

  let failed = 0
  let total = 0

  for (const file of specFiles) {
    const spec = await import(new URL(`./specs/${file}`, import.meta.url))
    const ctx = new Ctx(page, { width: 420, height: 900 })
    console.log(`\n▶ ${file.replace('.spec.mjs', '')}`)

    await ctx.resetOrigin()
    await ctx.goto()
    await ctx.setViewport(420, 900)

    try {
      await spec.run(ctx)
    } catch (error) {
      ctx.check(`스펙 실행`, false, String(error.message ?? error))
    }

    // 콘솔 오류는 스펙 실패로 본다 — key 충돌 같은 게 조용히 실패하기 때문이다
    const noisy = page.logs.filter((l) => !l.includes('DevTools'))
    page.logs = []
    ctx.check('콘솔 에러·경고 없음', noisy.length === 0, noisy.slice(0, 3).join(' | '))

    failed += ctx.results.filter((r) => !r.pass).length
    total += ctx.results.length
  }

  page.close()

  // 크롬이 프로필 디렉터리를 쓰는 중이라서 바로 지우면 ENOTEMPTY 가 난다
  const exited = new Promise((resolve) => chrome.on('exit', resolve))
  chrome.kill()
  await Promise.race([exited, sleep(3000)])
  killServer()
  await sleep(300)
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // 임시 디렉터리 정리는 실패해도 검증 결과에 영향이 없다
  }

  console.log(`\n${'─'.repeat(46)}`)
  console.log(`전체 ${total - failed}/${total} 통과`)
  return failed === 0 ? 0 : 1
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedDirectly) {
  const code = await runAll(process.argv[2])
  process.exit(code)
}