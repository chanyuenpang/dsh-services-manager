import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createManager } from '../src/supervisor.mjs'
// The packaging verifier reruns these CLIENT tests against only the installed package entry.
const { runCli, localOrigin } = await import(process.env.DSH_TEST_CLI_ENTRY ? pathToFileURL(process.env.DSH_TEST_CLI_ENTRY).href : '../src/cli.mjs')

async function call(args, env = {}, input = '', extra = {}) {
  let out = '', err = ''
  const code = await runCli(args, { env, stdin: Readable.from([input]), stdout: { write: (s) => { out += s } }, stderr: { write: (s) => { err += s } }, ...extra })
  return { code, out, err, json: code === 0 && out.startsWith('{') ? JSON.parse(out) : err ? JSON.parse(err) : null }
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-http-'))
  const configPath = path.join(dir, 'services.json')
  const token = 'test-token-unique-987654', cookie = 'session-cookie-unique-987654'
  let requests = 0, rpcRequests = 0, spawns = 0
  const listeners = new Map()
  const manager = createManager({ configPath, stateDir: dir, logDir: dir,
    ctx: { subprocess: { spawn() {
      spawns++; listeners.set(4567, 9999)
      return { done: new Promise(() => {}), terminate() { listeners.clear() }, waitForExit: async () => true }
    } } },
    io: { listListeners: async () => new Map(listeners), commandLines: async (pids) => new Map(pids.map((p) => [p, 'node app.mjs'])), tcpProbe: async (_, port) => listeners.has(port), waitForPortListening: async () => true, waitForPortFree: async () => true },
  })
  const server = http.createServer(async (req, res) => {
    requests++
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      if (url.searchParams.get('token') !== token) { res.writeHead(401); res.end('denied'); return }
      res.writeHead(303, { 'set-cookie': 'dsh_session=' + cookie + '; HttpOnly; SameSite=Strict; Path=/', location: '/' }); res.end(); return
    }
    if (req.headers.cookie !== 'dsh_session=' + cookie) { res.writeHead(403); res.end('denied'); return }
    rpcRequests++
    let raw = ''; for await (const chunk of req) raw += chunk
    const message = JSON.parse(raw)
    assert.equal(message.type, 'client-request')
    assert.equal(url.pathname, '/dsh-services/' + message.method)
    let result
    try { result = { ok: true, value: await manager.handle(message.method, message.payload) } }
    catch (e) { result = { ok: false, error: { code: e.code, message: e.message, details: e.details ?? {} } } }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await manager.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }) })
  const env = { DSH_SERVICES_URL: 'http://127.0.0.1:' + server.address().port, DSH_SERVICES_TOKEN: token }
  return { dir, manager, env, token, cookie, calls: () => ({ requests, rpcRequests, spawns }), raw: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) }
}
const service = { id: 'Exact.API', command: 'node app.mjs', cwd: 'C:/Services/My App', port: 4567, match: { commandLinePattern: 'app[.]mjs' } }

test('offline self-sufficient help never performs network and exposes installed location', async () => {
  const r = await call(['--help'], {}, '', { fetchImpl() { throw Error('must not fetch') } })
  assert.equal(r.code, 0)
  for (const term of ['Resolved CLI:', 'register --file', 'token-stdin', 'expectedRevision', 'CONFIG_CONFLICT', 'Exit codes:', 'policyCommitted', 'NOT an agent permission sandbox']) assert.ok(r.out.includes(term), term)
})

test('only explicit loopback literal URLs, no credentials or ambiguous spelling', async () => {
  assert.equal(localOrigin('http://localhost:3080'), 'http://127.0.0.1:3080')
  assert.equal(localOrigin('https://[::1]:3080/'), 'https://[::1]:3080')
  for (const url of ['https://example.com', 'http://127.0.0.1.evil', 'http://2130706433', 'http://127.1', 'http://0177.0.0.1', 'http://127.0.0.999', 'http://127.0.0.1/?token=SECRET', 'http://user:SECRET@127.0.0.1', 'http://[::ffff:127.0.0.1]', 'file:///tmp', 'http://127.0.0.1/path', 'http://127.0.0.1#SECRET']) {
    const r = await call(['list', '--url', url], { DSH_SERVICES_TOKEN: 'SECRET' }, '', { fetchImpl() { throw Error('must not fetch') } })
    assert.equal(r.code, 2, url); assert.ok(!r.err.includes('SECRET'))
  }
})

test('isolated real HTTP token-cookie RPC: file/stdin registration, list/start/stop and conflicts', async (t) => {
  const f = await fixture(t)
  const file = path.join(f.dir, 'service with spaces.json')
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(service))
  let r = await call(['register', '--file', file], f.env)
  assert.equal(r.code, 0, r.err); assert.equal(r.json.value.id, service.id)
  const revision = r.json.value.configRevision
  assert.equal(f.calls().spawns, 0); assert.equal(f.raw().services[0].autostart, false)
  r = await call(['register', '--file', '-', '--token-stdin'], { DSH_SERVICES_URL: f.env.DSH_SERVICES_URL }, f.token + '\r\n' + JSON.stringify({ id: service.id, title: 'New title' }))
  assert.equal(r.code, 0, r.err); assert.equal(f.raw().services.length, 1)
  r = await call(['register', '--file', file, '--revision', revision], f.env)
  assert.equal(r.code, 5, r.err); assert.equal(r.json.error.code, 'CONFIG_CONFLICT')
  assert.equal(f.raw().services[0].title, 'New title')
  r = await call(['list'], f.env); assert.equal(r.code, 0, r.err)
  assert.ok(r.json.value.services.some((s) => s.id === service.id))
  r = await call(['start', service.id], f.env); assert.equal(r.code, 0, r.err)
  assert.equal(f.raw().services[0].autostart, true); assert.equal(f.calls().spawns, 1)
  r = await call(['stop', service.id], f.env); assert.equal(r.code, 0, r.err)
  assert.equal(f.raw().services[0].autostart, false)
  r = await call(['remove', service.id], f.env); assert.equal(r.code, 0, r.err)
  assert.equal(f.raw().services.length, 0)
  for (const secret of [f.token, f.cookie]) assert.ok(!r.out.includes(secret) && !r.err.includes(secret))
})

test('unauthorized, missing credentials, usage, host failure have distinct exits and no retries', async (t) => {
  const f = await fixture(t)
  assert.equal((await call(['list'], { DSH_SERVICES_URL: f.env.DSH_SERVICES_URL })).code, 3)
  assert.equal((await call(['list'], { ...f.env, DSH_SERVICES_TOKEN: 'bad' })).code, 3)
  assert.equal(f.calls().rpcRequests, 0)
  assert.equal((await call(['start', 'missing'], f.env)).code, 6)
  assert.equal((await call(['start', 'dsh'], f.env)).code, 2)
  assert.equal((await call(['restart-dsh'], f.env)).code, 2)
  assert.equal((await call(['register', '--file', '-'], f.env, '{bad json')).code, 2)
  assert.equal((await call(['register', '--file', '-'], f.env, JSON.stringify({ ...service, typo: true }))).code, 2)
  assert.equal((await call(['list'], f.env, '', { fetchImpl() { throw Error(f.token) } })).code, 4)
})

test('redirects never followed and credentials redacted even when host echoes them', async () => {
  const token = 'super-secret-token', cookie = 'super-secret-cookie'
  let count = 0
  const env = { DSH_SERVICES_URL: 'http://127.0.0.1:1234', DSH_SERVICES_TOKEN: token }
  const fetchImpl = async (_url, init) => {
    assert.equal(init.redirect, 'manual'); count++
    if (count === 1) return new Response(null, { status: 303, headers: { 'set-cookie': 's=' + cookie, location: 'https://external.invalid/' } })
    return new Response(JSON.stringify({ type: 'server-response', result: { ok: false, error: { code: 'OPERATION_FAILED', message: token, details: { echo: cookie, url: token } } } }))
  }
  const r = await call(['list'], env, '', { fetchImpl })
  assert.equal(r.code, 6); assert.equal(count, 2)
  assert.ok(!r.err.includes(token) && !r.err.includes(cookie))
  count = 0
  const redirected = await call(['list'], env, '', { fetchImpl: async (_, init) => { assert.equal(init.redirect, 'manual'); count++; return new Response(null, { status: 302, headers: { location: 'https://external.invalid/' } }) } })
  assert.equal(redirected.code, 3); assert.equal(count, 1)
})

test('protocol missing value/error details rejected rather than claimed successful', async () => {
  for (const result of [{ ok: true, data: {} }, { ok: false, error: { code: 'ERR', message: 'bad' } }]) {
    let count = 0
    const r = await call(['list'], { DSH_SERVICES_URL: 'http://127.0.0.1:1234', DSH_SERVICES_TOKEN: 'test-secret' }, '', { fetchImpl: async () => ++count === 1 ? new Response(null, { status: 303, headers: { 'set-cookie': 's=cookie-secret' } }) : new Response(JSON.stringify({ type: 'server-response', result })) })
    assert.equal(r.code, 4); assert.equal(r.json.error.code, 'PROTOCOL')
  }
})
