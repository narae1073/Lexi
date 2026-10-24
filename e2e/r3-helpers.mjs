/**
 * Shared support for the R3 end-to-end gates (specs 41 and 42).
 *
 * The existing harness boots the real built app in headless Chrome. These
 * helpers add only what an authenticated projection flow needs:
 *
 * - a local-only test user (admin API refuses non-loopback URLs);
 * - a real password session injected into the app's Supabase storage key;
 * - request / Worker probes installed before the app script runs;
 * - IndexedDB readers for projection state and device-local stores.
 *
 * Nothing here writes to a remote Supabase project: {@link resolveLocalConfig}
 * rejects every non-loopback URL.
 */

import {
  DEFAULT_PASSWORD,
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  psql,
  psqlJson,
  resolveLocalConfig,
  sqlLiteral,
} from '../scripts/r3-load-common.mjs'

export {
  DEFAULT_PASSWORD,
  adminListUsers,
  psql,
  psqlJson,
  resolveLocalConfig,
  sqlLiteral,
}

export const PROJECTION_LANGUAGE = 'en'

/** The app's Supabase storage key: `sb-<first host label>-auth-token`. */
export function authStorageKey(url) {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
}

/** Signs in through GoTrue and returns a session localStorage can hold. */
export async function passwordSession(config, email, password = DEFAULT_PASSWORD) {
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Local sign-in failed for ${email}: HTTP ${response.status} ${text.slice(0, 300)}`)
  }
  const session = JSON.parse(text)
  if (!session.access_token || !session.refresh_token) {
    throw new Error(`Local sign-in returned no session for ${email}`)
  }
  // auth-js requires expires_at to consider the stored session valid.
  session.expires_at ??= Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600)
  return session
}

/** Creates a fresh local test user (removing an earlier run with the same email). */
export async function prepareTestUser(email, index = 0) {
  const config = resolveLocalConfig()
  const users = await adminListUsers(config)
  for (const user of users) {
    if (user.email === email) await adminDeleteUser(config, user.id)
  }
  const created = await adminCreateUser(config, {
    email,
    password: DEFAULT_PASSWORD,
    index,
  })
  if (!created?.id) throw new Error(`Admin API did not return an id for ${email}`)
  const session = await passwordSession(config, email)
  return { config, user: created, session }
}

export async function deleteTestUser(config, userId) {
  await adminDeleteUser(config, userId)
}

/**
 * Installs the request and Worker probes in every future document.
 *
 * Must be called before `ctx.reload()` so the probes exist before the app
 * bundle runs. `fetch` covers Supabase's PostgREST and Auth clients; the
 * Worker wrapper records the projection read-model round trips without
 * changing their semantics.
 */
export async function installProbes(ctx) {
  const source = `(() => {
    if (window.__r3Probes) return;
    window.__r3Probes = true;
    window.__r3Requests = [];
    window.__r3WorkerCalls = [];

    const record = (url, method, body) => {
      window.__r3Requests.push({
        url: String(url),
        method: String(method || 'GET').toUpperCase(),
        body: typeof body === 'string' ? body : body == null ? null : String(body),
        at: performance.now(),
      });
      if (window.__r3Requests.length > 5000) window.__r3Requests.splice(0, 1000);
    };

    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        const method = (init && init.method) || (input && input.method) || 'GET';
        let body = init && init.body;
        if (body === undefined && input && typeof input.clone === 'function') {
          body = input.clone().text();
        }
        if (body && typeof body.then === 'function') {
          body.then((value) => record(url, method, value)).catch(() => record(url, method, null));
        } else {
          record(url, method, body);
        }
      } catch {}
      return nativeFetch.apply(this, arguments);
    };

    const NativeWorker = window.Worker;
    if (NativeWorker) {
      window.__r3Workers = [];
      window.Worker = class R3ProbeWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          try { window.__r3Workers.push(this); } catch {}
        }
        postMessage(message, transfer) {
          try {
            if (message && window.__r3WorkerCalls && ['rebuild', 'search', 'progress'].includes(message.type)) {
              const started = performance.now();
              const id = message.id;
              const type = message.type;
              const onMessage = (event) => {
                const data = event.data;
                const same = id === undefined ? data && data.type === type : data && data.id === id;
                if (!same) return;
                this.removeEventListener('message', onMessage);
                window.__r3WorkerCalls.push({
                  type,
                  ms: performance.now() - started,
                  at: performance.now(),
                  total: data.total ?? null,
                  statusCount: message.statuses ? Object.keys(message.statuses).length : null,
                });
              };
              this.addEventListener('message', onMessage);
            }
          } catch {}
          return super.postMessage(message, transfer);
        }
      };
    }
  })()`
  await ctx.page.send('Page.addScriptToEvaluateOnNewDocument', { source })
}

/** Writes the session and clears any app state that could mask a first sync. */
export async function startSession(ctx, { config, session, languages = null }) {
  const key = authStorageKey(config.url)
  await ctx.page.evaluate(`(() => {
    localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(session))});
    ${languages === null ? '' : `localStorage.setItem('lexi.languages', ${JSON.stringify(JSON.stringify({ state: { enrolled: languages, ready: true }, version: 0 }))});`}
    return true;
  })()`)
  await ctx.reload()
}

/** Waits until the account sync has adopted a language and the nav is visible. */
export async function waitForAppReady(ctx, timeoutMs = 180_000) {
  await ctx.waitFor(
    `!!document.querySelector('a[href="/wordbook"]')`,
    'account sync and language adoption',
    timeoutMs,
  )
}

export async function requests(ctx) {
  return (await ctx.page.evaluate('window.__r3Requests || []')) ?? []
}

export async function workerCalls(ctx) {
  return (await ctx.page.evaluate('window.__r3WorkerCalls || []')) ?? []
}

export function projectionRequests(log) {
  return log
    .filter((entry) => entry.url.includes('/rpc/get_wordbook_projection_page'))
    .map((entry) => {
      let body = null
      try {
        body = entry.body ? JSON.parse(entry.body) : null
      } catch {
        body = null
      }
      return { ...entry, params: body }
    })
}

export function tableReads(log, table) {
  return log.filter(
    (entry) =>
      entry.url.includes(`/rest/v1/${table}`) &&
      !entry.url.includes('/rpc/') &&
      entry.method === 'GET',
  )
}

export function tableWrites(log, table) {
  return log.filter(
    (entry) =>
      entry.url.includes(`/rest/v1/${table}`) &&
      !entry.url.includes('/rpc/') &&
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes(entry.method),
  )
}

export function rpcWrites(log, name) {
  return log.filter(
    (entry) =>
      entry.url.includes(`/rpc/${name}`) &&
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes(entry.method),
  )
}

/** Runs a function in the page's IndexedDB and returns its result. */
export async function idb(ctx, body) {
  return ctx.page.evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('lexi');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await (${body})(db);
    } finally {
      db.close();
    }
  })()`)
}

export async function storeCount(ctx, store) {
  return idb(
    ctx,
    `(db) => new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(${JSON.stringify(store)})) return resolve(0);
      const request = db.transaction(${JSON.stringify(store)}, 'readonly').objectStore(${JSON.stringify(store)}).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })`,
  )
}

export async function storeRows(ctx, store) {
  return idb(
    ctx,
    `(db) => new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(${JSON.stringify(store)})) return resolve([]);
      const request = db.transaction(${JSON.stringify(store)}, 'readonly').objectStore(${JSON.stringify(store)}).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })`,
  )
}

export function projectionStateKey(userId) {
  return `__lexi_projection_state__:${userId}`
}

export async function readProjectionState(ctx, userId) {
  const key = projectionStateKey(userId)
  return idb(
    ctx,
    `(db) => new Promise((resolve, reject) => {
      const request = db.transaction('documentMeta', 'readonly').objectStore('documentMeta').get(${JSON.stringify(key)});
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    })`,
  )
}

export async function waitForProjectionComplete(ctx, userId, language, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = await readProjectionState(ctx, userId)
    const state = record?.state?.[language]
    if (state?.complete === true) return state
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`projection did not complete for ${language} within ${timeoutMs} ms`)
}

/**
 * Puts the local page quota one request below its 60/minute limit so the next
 * sync reads one page and then receives a recoverable 429.
 *
 * The quota window is epoch-aligned; if the current minute is nearly over the
 * helper waits for a fresh window so the result is deterministic.
 */
export async function seedPageQuota(config, userId, count = 59) {
  const seconds = await psqlJson(
    config,
    `select jsonb_build_object(
       'seconds', floor(extract(epoch from clock_timestamp()))::int % 60
     );`,
  )
  const intoWindow = seconds?.seconds ?? 0
  // Leave enough room for the browser reload and the first page request. A
  // seed near the end of the epoch minute would roll into a fresh bucket and
  // silently give the sync all 60 requests.
  if (intoWindow > 40) {
    await new Promise((resolve) => setTimeout(resolve, (61 - intoWindow) * 1000))
  }
  await psql(
    config,
    `
    delete from public.projection_usage where user_id = ${sqlLiteral(userId)}::uuid;
    insert into public.projection_usage (user_id, bucket, window_start, count)
    values (
      ${sqlLiteral(userId)}::uuid,
      'projection_page',
      to_timestamp(floor(extract(epoch from clock_timestamp()) / 60) * 60),
      ${Number(count)}
    )
    on conflict (user_id, bucket, window_start)
    do update set count = excluded.count;
    `,
  )
}

export async function clearProjectionQuota(config, userId) {
  await psql(
    config,
    `
    delete from public.projection_usage where user_id = ${sqlLiteral(userId)}::uuid;
    delete from public.projection_sync_passes where user_id = ${sqlLiteral(userId)}::uuid;
    `,
  )
}

/**
 * Clears only the per-minute page counters, keeping the complete-pass rows.
 *
 * The resume test must not delete `projection_sync_passes`: doing so would hide
 * whether the client really resumed the charged snapshot and would make the
 * "same snapshot, one pass" assertions vacuous.
 */
export async function clearProjectionPageQuota(config, userId) {
  await psql(
    config,
    `delete from public.projection_usage where user_id = ${sqlLiteral(userId)}::uuid;`,
  )
}

/** Reads the pass row the server stores for one user/snapshot/language. */
export async function projectionPassState(config, userId, snapshot, language) {
  return psqlJson(
    config,
    `
    select jsonb_build_object(
      'count', count(*),
      'complete', bool_or(complete),
      'snapshot', min(snapshot)
    )
    from public.projection_sync_passes
    where user_id = ${sqlLiteral(userId)}::uuid
      and snapshot = ${sqlLiteral(snapshot)}::timestamptz
      and language_code = ${sqlLiteral(language)};
    `,
  )
}

/**
 * Measures one progress round trip on an already-rebuilt app worker.
 *
 * The client queues `progress` behind any in-flight rebuild, so its wall time
 * includes unrelated rebuild work. This posts the same protocol message
 * directly to every live worker after the UI has settled and reports the first
 * answer: the computation and its result serialization, not queueing.
 */
export async function measureWorkerProgress(ctx, statuses = undefined) {
  const payload = statuses === undefined ? '' : `, statuses: ${JSON.stringify(statuses)}`
  return ctx.page.evaluate(`(async () => {
    const deadline = performance.now() + 10_000;
    let workers = [];
    while (performance.now() < deadline) {
      const documentWorkers = (window.__r3Workers || []).filter(
        (worker) => worker.__r3Role === 'document-list' && worker.__r3Rebuilt === true,
      );
      // A navigation unmounts the previous DocumentList worker but leaves its
      // probe entry in the array; the newest rebuilt instance owns the dataset.
      workers = documentWorkers.slice(-1);
      if (workers.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (workers.length === 0) return { ms: -1, progress: 0 };
    const id = 2_000_000_000;
    const started = performance.now();
    return await new Promise((resolve) => {
      let settled = false;
      const cleanups = [];
      const finish = (value) => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups) cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ms: -2, progress: 0 }), 3000);
      cleanups.push(() => clearTimeout(timer));
      for (const worker of workers) {
        const onMessage = (event) => {
          const data = event.data;
          if (!data || data.id !== id || data.type !== 'progress') return;
          finish({
            ms: performance.now() - started,
            progress: Object.keys(data.progress || {}).length,
          });
        };
        worker.addEventListener('message', onMessage);
        cleanups.push(() => worker.removeEventListener('message', onMessage));
        worker.postMessage({ type: 'progress', id${payload} });
      }
    });
  })()`)
}

/** Navigates inside the app without a full reload. */export async function navigate(ctx, path) {
  await ctx.page.evaluate(`(() => {
    const anchor = [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === ${JSON.stringify(path)});
    if (anchor) { anchor.click(); return true; }
    location.href = ${JSON.stringify(path)};
    return false;
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 300))
}

export async function searchWordbook(ctx, query) {
  await ctx.page.evaluate(`(() => {
    const input = document.querySelector('input[placeholder]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}
