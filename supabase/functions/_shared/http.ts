/**
 * Edge Function 요청 본문 파싱.
 *
 * `req.json()` 은 본문을 끝까지 읽은 뒤에만 실패하므로, 큰 요청이 파싱 비용을
 * 쓰게 둘 수 없다. 여기서는 선언된 Content-Length 를 먼저 보고, 헤더가 없거나
 * 거짓말을 해도 실제 스트림 바이트를 세어 상한을 지킨다.
 *
 * 파싱/크기 오류는 던지지 않고 결과로 돌려준다 — 호출자가 그대로 HTTP 상태로
 * 매핑하기만 하면 된다.
 */

export type ReadJsonBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string }

/** Content-Length 는 0 이상의 십진 정수만 허용한다 (음수/소수/지수 표기 거부) */
function parseDeclaredLength(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const length = Number(trimmed)
  // 자릿수가 너무 많아 Infinity 가 된 값은 non-finite 로 본다
  return Number.isFinite(length) ? length : null
}

export async function readJsonBody<T = unknown>(
  req: Request,
  maxBytes: number,
): Promise<ReadJsonBodyResult<T>> {
  const declared = req.headers.get('content-length')
  if (declared !== null) {
    const length = parseDeclaredLength(declared)
    if (length === null) {
      return { ok: false, status: 400, error: 'invalid content-length' }
    }
    if (length > maxBytes) {
      return { ok: false, status: 413, error: 'request body too large' }
    }
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    reader = req.body?.getReader()
  } catch {
    return { ok: false, status: 400, error: 'unreadable request body' }
  }
  if (!reader) return { ok: false, status: 400, error: 'empty request body' }

  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      total += value.byteLength
      // 헤더가 없거나 실제 길이와 달라도 여기서 막는다
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, status: 413, error: 'request body too large' }
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => {})
    return { ok: false, status: 400, error: 'unreadable request body' }
  }

  if (total === 0) return { ok: false, status: 400, error: 'empty request body' }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  const text = new TextDecoder().decode(bytes)
  if (text.trim() === '') return { ok: false, status: 400, error: 'empty request body' }

  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
}
