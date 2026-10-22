#!/usr/bin/env node
/**
 * Exercise the real verifier against a local-only HTTP fixture with a CSP
 * weakening directive. This never contacts the production origin.
 *
 *   node scripts/verify-headers-self-test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const verifier = fileURLToPath(new URL('./verify-headers.mjs', import.meta.url))
const correctCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://gwsrowpbcqwtpciknayl.supabase.co",
].join('; ')
let csp = correctCsp

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('content-security-policy', csp)

  if (path === '/') {
    response.setHeader('content-type', 'text/html')
    response.setHeader('cache-control', 'no-cache')
    response.end('<script src="/assets/app-abcdef.js"></script>')
  } else if (path === '/sw.js') {
    response.setHeader('content-type', 'text/javascript')
    response.setHeader('cache-control', 'no-cache')
    response.end("importScripts('/assets/app-abcdef.js')")
  } else if (path === '/manifest.webmanifest') {
    response.setHeader('content-type', 'application/manifest+json')
    response.setHeader('cache-control', 'no-cache')
    response.end('{}')
  } else if (path === '/assets/app-abcdef.js') {
    response.setHeader('content-type', 'text/javascript')
    response.setHeader('cache-control', 'public, max-age=31536000, immutable')
    response.end('')
  } else {
    response.statusCode = 404
    response.end('not found')
  }
})

function runVerifier(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, origin], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, output }))
  })
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const negativeCases = [
    {
      name: 'added script-src-elem',
      value: `${correctCsp}; script-src-elem 'unsafe-inline'`,
      expected: /script-src-elem is not in the approved CSP/i,
    },
    {
      name: 'duplicate default-src',
      value: `${correctCsp}; default-src 'unsafe-inline'`,
      expected: /default-src is duplicated/i,
    },
    {
      name: 'missing frame-ancestors',
      value: correctCsp.replace("frame-ancestors 'none'; ", ''),
      expected: /frame-ancestors missing/i,
    },
    {
      name: 'incorrect script-src value',
      value: correctCsp.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline'"),
      expected: /script-src is .*expected/i,
    },
  ]

  for (const testCase of negativeCases) {
    csp = testCase.value
    const result = await runVerifier(origin)
    assert.equal(result.signal, null, result.output)
    assert.equal(result.code, 1, `Verifier should reject ${testCase.name}. Output:\n${result.output}`)
    assert.match(result.output, testCase.expected)
  }
  console.log('PASS: verifier rejects extra, duplicate, missing, and incorrect CSP directives locally.')
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}
