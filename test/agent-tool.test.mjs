import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentTool, registerAgentTool } from '../src/agent-tool.mjs'
import { createManager } from '../src/supervisor.mjs'

function fixture(t, { mode = 'danger-full-access', outcome = 'allowed-once', document, approval = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-native-'))
  const configPath = path.join(dir, 'services.json')
  if (document) fs.writeFileSync(configPath, JSON.stringify(document))
  let calls = 0, prompts = 0, spawns = 0
  const manager = createManager({ configPath, stateDir: dir, logDir: dir, ctx: { subprocess: { spawn() { spawns++; throw Error('must not spawn') } } } })
  const original = manager.agentRegister
  manager.agentRegister = (...args) => { calls++; return original(...args) }
  const session = { id: 'test-session' }
  const exec = { agent: { id: session.id, session }, callId: 'call-id', signal: new AbortController().signal }
  const ctx = { sandboxPolicy: { resolve(req) { assert.equal(req.session, session); return { mode } } }, get(key) { assert.equal(key, 'approval'); return approval ? { request: async (req) => { prompts++; assert.equal(req.agent, exec.agent); assert.equal(req.callId, exec.callId); assert.equal(req.signal, exec.signal); return typeof outcome === 'function' ? outcome(req) : outcome } } : undefined } }
  const tool = createAgentTool(ctx, manager)
  const call = (args, run = exec) => tool.execute(args, run)
  const service = { id: 'api.Exact', command: 'node "C:/Projects/server.mjs" --port 4567', cwd: dir, port: 4567, match: { commandLinePattern: 'C:[/\\\\]Projects[/\\\\]server[.]mjs.*4567' } }
  t.after(async () => { await manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, configPath, manager, service, exec, ctx, tool, call, counts: () => ({ calls, prompts, spawns }), mode: (value) => { mode = value } }
}
async function register(f, patch = f.service, revision) {
  const listed = await f.call({ action: 'list' })
  assert.equal(listed.ok, true)
  return f.call({ action: 'register', service: patch, expectedRevision: revision ?? listed.value.configRevision })
}

test('native safe reads do not seed a missing config; paging and input are strict', async (t) => {
  const f = fixture(t, { mode: 'read-only' })
  const list = await f.call({ action: 'list' })
  assert.equal(list.ok, true); assert.equal(list.value.total, 0); assert.equal(list.value.runtimeObserved, false)
  assert.equal((await f.call({ action: 'get', id: 'missing' })).error.code, 'SERVICE_NOT_FOUND')
  assert.equal(fs.existsSync(f.configPath), false)
  for (const args of [{ action: 'list', limit: 101 }, { action: 'list', offset: -1 }, { action: 'get', id: 'api', raw: true }, { action: 'restart-dsh' }, { action: 'list', token: 'NO' }]) assert.equal((await f.call(args)).error.code, 'CONFIG_INVALID')
  assert.deepEqual(f.counts(), { calls: 0, prompts: 0, spawns: 0 })
})

test('full-access registers without auth or process side effects, exact id and CAS are shared with UI', async (t) => {
  const f = fixture(t)
  const first = await register(f)
  assert.deepEqual(first.value, { id: f.service.id, registered: true, started: false, changed: true, configRevision: first.value.configRevision, autostart: false })
  const repeat = await register(f)
  assert.equal(repeat.value.changed, false); assert.equal(repeat.value.configRevision, first.value.configRevision)
  const ui = await f.manager.handle('config.get')
  assert.equal(JSON.parse(ui.raw).services.length, 1)
  await f.manager.handle('config.upsert', { service: { id: f.service.id, title: 'UI winner' }, expectedRevision: ui.revision })
  const before = fs.readFileSync(f.configPath, 'utf8')
  const stale = await register(f, { id: f.service.id, title: 'lost' }, ui.revision)
  assert.equal(stale.error.code, 'CONFIG_CONFLICT'); assert.equal(fs.readFileSync(f.configPath, 'utf8'), before)
  const explicit = await register(f, { id: f.service.id, autostart: true })
  assert.equal(explicit.value.autostart, true); assert.equal(explicit.value.started, false)
  assert.equal((await f.call({ action: 'get', id: f.service.id })).value.service.title, 'UI winner')
  assert.equal(f.counts().prompts, 0); assert.equal(f.counts().spawns, 0)
})

test('read-only/agentless/missing policy calls fail closed without manager or disk writes', async (t) => {
  const f = fixture(t, { mode: 'read-only' })
  assert.equal((await register(f)).error.code, 'PERMISSION_DENIED')
  assert.equal((await f.call({ action: 'list' }, { signal: f.exec.signal })).error.code, 'AGENT_CONTEXT_REQUIRED')
  assert.equal((await f.call({ action: 'list' }, { ...f.exec, agent: { id: 'other', session: f.exec.agent.session } })).error.code, 'AGENT_CONTEXT_REQUIRED')
  f.ctx.sandboxPolicy = undefined
  assert.equal((await f.call({ action: 'list' })).error.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual(f.counts(), { calls: 0, prompts: 0, spawns: 0 }); assert.equal(fs.existsSync(f.configPath), false)
})

test('workspace-write approval is exact, single-call, and never alters mode', async (t) => {
  const f = fixture(t, { mode: 'workspace-write' })
  assert.equal((await register(f)).ok, true)
  assert.equal((await register(f, { id: f.service.id, title: 'second' })).ok, true)
  assert.equal(f.counts().prompts, 2)
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: f.exec.agent.session }).mode, 'workspace-write')
  for (const outcome of ['rejected', 'cancelled', 'unavailable', 'never']) {
    const denied = fixture(t, { mode: 'workspace-write', outcome })
    assert.equal((await register(denied)).error.code, 'PERMISSION_DENIED')
    assert.equal(denied.counts().calls, 0); assert.equal(fs.existsSync(denied.configPath), false)
  }
  const missing = fixture(t, { mode: 'workspace-write', approval: false })
  assert.equal((await register(missing)).error.code, 'PERMISSION_DENIED')
})

test('permission downgrade or cancellation during prompt prevents commit', async (t) => {
  let f
  f = fixture(t, { mode: 'workspace-write', outcome: () => { f.mode('read-only'); return 'allowed-once' } })
  assert.equal((await register(f)).error.code, 'PERMISSION_DENIED'); assert.equal(f.counts().calls, 0)
  const controller = new AbortController()
  const g = fixture(t, { mode: 'workspace-write', outcome: () => { controller.abort(); return 'allowed-once' } })
  g.exec.signal = controller.signal
  assert.equal((await register(g)).error.code, 'CANCELLED'); assert.equal(g.counts().calls, 0)
})

test('DTOs and errors never echo raw/commands/signatures/env/URL credentials/Host argv', async (t) => {
  const secret = 'DO_NOT_LEAK_123'
  const f = fixture(t, { document: { version: 1, services: [
    { id: 'secret', command: 'node ' + secret, cwd: os.tmpdir(), port: 4567, env: { TOKEN: secret }, match: { commandLinePattern: secret }, url: 'http://user:' + secret + '@127.0.0.1:4567/private/' + secret + '?token=' + secret + '#' + secret },
    { id: 'other', command: 'node other.mjs', cwd: os.tmpdir(), port: 4568, extension: { preserve: true } },
  ] } })
  for (const args of [{ action: 'list', limit: 1 }, { action: 'get', id: 'secret' }]) {
    const result = await f.call(args)
    assert.equal(result.ok, true)
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(f.tool.output.render(args, result)).includes(secret))
  }
  assert.equal((await f.call({ action: 'get', id: 'secret' })).value.service.url, 'http://127.0.0.1:4567/')
  const saved = await register(f, { id: 'secret', title: 'updated' })
  assert.equal(saved.ok, true)
  const raw = JSON.parse(fs.readFileSync(f.configPath, 'utf8'))
  assert.equal(raw.services[0].env.TOKEN, secret); assert.equal(raw.services[1].extension.preserve, true)
  const denied = await register(f, { id: 'secret', env: { TOKEN: secret } })
  assert.equal(denied.error.code, 'CONFIG_INVALID'); assert.ok(!JSON.stringify(denied).includes(secret))
  f.manager.agentDefinitions = () => { throw Object.assign(Error(secret), { code: 'CONFIG_INVALID', details: { raw: secret, env: secret } }) }
  assert.ok(!JSON.stringify(await f.call({ action: 'list' })).includes(secret))
})

test('effective legacy unsafe fields, relative/missing cwd and bad revisions are rejected', async (t) => {
  for (const legacy of [{ takeover: 'force' }, { restartMode: 'supervisor' }]) {
    const f = fixture(t, { document: { services: [{ id: 'legacy', command: 'node legacy.mjs', cwd: os.tmpdir(), port: 4567, ...legacy }] } })
    const before = fs.readFileSync(f.configPath, 'utf8')
    assert.equal((await register(f, { id: 'legacy', title: 'test' })).error.code, 'CONFIG_INVALID')
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before)
  }
  const f = fixture(t)
  for (const cwd of ['relative', path.join(f.dir, 'missing')]) assert.equal((await register(f, { ...f.service, cwd })).error.code, 'CONFIG_INVALID')
  assert.equal((await register(f, f.service, 'invalid')).error.code, 'CONFIG_INVALID')
  assert.equal(f.counts().spawns, 0)
})

test('stale patch after concurrent UI deletion returns conflict, never creates a partial entry', async (t) => {
  const f = fixture(t)
  const first = await register(f)
  await f.manager.handle('config.remove', { id: f.service.id, expectedRevision: first.value.configRevision })
  const result = await register(f, { id: f.service.id, title: 'stale' }, first.value.configRevision)
  assert.equal(result.error.code, 'CONFIG_CONFLICT')
  assert.equal((await f.call({ action: 'list' })).value.total, 0)
})

test('approval shows effective canonical directory and policy for patches, and failures have safe repair hints', async (t) => {
  let prompt
  const f = fixture(t, { mode: 'workspace-write', outcome: (req) => { prompt = req.reason; return 'allowed-once' } })
  await register(f)
  await register(f, { id: f.service.id, autostart: true })
  assert.ok(prompt.includes('cwd=' + fs.realpathSync(f.dir))); assert.ok(prompt.includes('effective autostart=true'))
  const bad = await register(f, { id: f.service.id, cwd: path.join(f.dir, 'missing') })
  assert.deepEqual(bad.error.details, { reason: 'CWD_NOT_FOUND', field: 'cwd' })
  assert.ok(bad.error.nextStep.includes('exists'))
})

test('physical approval target cannot change while a junction is awaiting approval', async (t) => {
  let link, targetB
  const f = fixture(t, { mode: 'workspace-write', outcome: () => {
    assert.equal(path.dirname(link), f.dir)
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    fs.unlinkSync(link)
    fs.symlinkSync(targetB, link, process.platform === 'win32' ? 'junction' : 'dir')
    return 'allowed-once'
  } })
  const targetA = path.join(f.dir, 'target-a'); targetB = path.join(f.dir, 'target-b'); link = path.join(f.dir, 'approved-link')
  fs.mkdirSync(targetA); fs.mkdirSync(targetB)
  fs.symlinkSync(targetA, link, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await register(f, { ...f.service, cwd: link })
  assert.equal(result.error.code, 'CONFIG_INVALID')
  assert.equal(result.error.details.reason, 'APPROVAL_TARGET_CHANGED')
  assert.equal(fs.existsSync(f.configPath), false)
})

test('throwing approval fails closed as permission denial without raw error leakage', async (t) => {
  const f = fixture(t, { mode: 'workspace-write', outcome: () => { throw Error('DO_NOT_ECHO_APPROVAL') } })
  const result = await register(f)
  assert.equal(result.error.code, 'PERMISSION_DENIED'); assert.equal(f.counts().calls, 0)
  assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO_APPROVAL'))
})

test('global optional registration belongs to the injecting context and unload disposer', () => {
  let tool, disposed = false
  const ctx = { inject(names, callback) {
    assert.deepEqual(names, ['tools', 'sandboxPolicy'])
    callback({ tools: { register(value) { tool = value; return () => { disposed = true } } }, effect(fn) { const dispose = fn(); dispose() } })
  } }
  registerAgentTool(ctx, {})
  assert.equal(tool.name, 'services_manager'); assert.equal(disposed, true)
})
