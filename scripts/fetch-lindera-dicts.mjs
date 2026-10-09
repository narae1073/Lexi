/**
 * lindera 형태소 사전 내려받기 — 일본어(IPADIC) + 중국어(CC-CEDICT).
 *
 * 사전은 번들에 넣지 않는다. 첫 사용 시 앱이 런타임에 내려받아 OPFS 에 캐시하고,
 * 여기서 받는 파일은 그 원본 zip 이다. 이미 있으면 받지 않는다.
 * precache 대상이 아니므로 PWA 용량에 들지 않는다.
 *
 *   npm run dict:ja    # 일본어만
 *   npm run dict:zh    # 중국어만
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '5.3.0'
const DICTS = {
  ja: `lindera-ipadic-${VERSION}.zip`,
  zh: `lindera-cc-cedict-${VERSION}.zip`,
}

const wanted = process.argv[2] === 'zh' ? ['zh'] : process.argv[2] === 'ja' ? ['ja'] : ['ja', 'zh']
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

for (const key of wanted) {
  const filename = DICTS[key]
  const url = `https://github.com/lindera/lindera/releases/download/v${VERSION}/${filename}`
  const dest = join(root, 'public', 'dicts', filename)

  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`있다 — 받지 않는다: public/dicts/${filename}`)
    continue
  }

  mkdirSync(dirname(dest), { recursive: true })
  console.log(`받는다: ${url}`)

  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`사전 다운로드 실패: ${response.status}`)
  }

  const expected = Number(response.headers.get('content-length') ?? 0)
  await new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    response.body.pipeTo(new WritableStream({
      write: (chunk) => new Promise((res, rej) => file.write(chunk, (e) => (e ? rej(e) : res()))),
      close: () => file.end(resolve),
      abort: reject,
    })).catch(reject)
  })

  const actual = statSync(dest).size
  if (expected > 0 && actual !== expected) {
    throw new Error(`덜 받았다: ${actual} / ${expected}`)
  }
  console.log(`됐다: public/dicts/${filename} (${(actual / 1048576).toFixed(1)}MB)`)
}
