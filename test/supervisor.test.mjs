import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createManager, detectDshRuntime, normalizeRestartGraceSeconds } from '../src/supervisor.mjs'
import { desktopLaunchEnvironment, isDesktopHostProcess, parseArgs as parseRestartScriptArgs, restartTargetFrom, webEntryFrom } from '../src/restart-supervisor.mjs'
import { readConfig } from '../src/config.mjs'

test('explicit panel three-second grace is accepted; other RPC callers retain 60-second fallback', () => {
  assert.equal(normalizeRestartGraceSeconds(3), 3)
  assert.equal(normalizeRestartGraceSeconds(2), 3)
  assert.equal(normalizeRestartGraceSeconds(0), 3)
  assert.equal(normalizeRestartGraceSeconds(15), 15)
  assert.equal(normalizeRestartGraceSeconds(undefined), 60)
  assert.equal(normalizeRestartGraceSeconds('not a number'), 60)
  assert.equal(normalizeRestartGraceSeconds(3601), 3600)
  assert.equal(parseRestartScriptArgs([]).graceSeconds, 3)
  assert.equal(parseRestartScriptArgs(['--grace', '60']).graceSeconds, 60)
})

test('Desktop runtime and owning Electron root are detected without treating it as CLI Web', () => {
  const exe = 'H:\\Program Files\\Deepseek\\DeepSeek Harness.exe'
  const desktopCommand = `"${exe}" H:\\Program Files\\Deepseek\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js`
  const rows = [
    { ProcessId: 43308, ParentProcessId: 900, ExecutablePath: exe, CommandLine: `"${exe}"` },
    { ProcessId: 23296, ParentProcessId: 43308, ExecutablePath: exe, CommandLine: desktopCommand },
  ]
  assert.equal(detectDshRuntime(['electron', 'x/@deepseek-ai/dsh-desktop-host/lib/index.js']), 'desktop')
  assert.equal(detectDshRuntime(['node', 'x/@deepseek-ai/dsh/lib/bin.js', 'web']), 'web')
  assert.equal(isDesktopHostProcess(desktopCommand), true)
  assert.equal(webEntryFrom(desktopCommand), null)
  assert.deepEqual(restartTargetFrom(23296, rows), {
    kind: 'desktop', listenerPid: 23296, stopPid: 43308, executablePath: exe, entryPath: null, args: [],
  })
})

test('CLI Web target keeps its own installation entry and Desktop launch strips Node mode', () => {
  const entry = 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
  const command = `"C:\\Program Files\\nodejs\\node.exe" "${entry}" web --profile work --port 3088 --no-open`
  assert.equal(webEntryFrom(command), entry)
  assert.deepEqual(restartTargetFrom(77, [{ ProcessId: 77, ParentProcessId: 1, ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: command }]), {
    kind: 'web', listenerPid: 77, stopPid: 77, executablePath: process.execPath, entryPath: entry,
    args: ['web', '--profile', 'work', '--port', '3088'],
  })
  const environment = desktopLaunchEnvironment({ ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: 'electron.exe', NODE_CHANNEL_FD: '3', KEEP: 'yes' })
  assert.deepEqual(environment, { KEEP: 'yes' })
})

test('unknown listeners and incomplete Desktop parent chains are refused', () => {
  assert.equal(restartTargetFrom(4, [{ ProcessId: 4, ParentProcessId: 1, ExecutablePath: 'x.exe', CommandLine: 'unrelated' }]), null)
  const command = 'DeepSeek Harness.exe C:\\app\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'
  assert.equal(restartTargetFrom(5, [{ ProcessId: 5, ParentProcessId: 1, ExecutablePath: 'DeepSeek Harness.exe', CommandLine: command }]), null)
})

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const turn = () => new Promise((resolve) => setImmediate(resolve))

function fixture(t, overrides = {}, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-unit-'))
  const configPath = path.join(dir, 'services.json')
  const definition = { id: 'one', command: 'node service.mjs', cwd: dir, port: 4999, match: { commandLinePattern: 'service\\.mjs' }, ...overrides }
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, services: [definition, ...extra] }))
  const listeners = new Map()
  const commands = new Map()
  const handles = []
  const kills = []
  const controls = {}
  const io = {
    listListeners: async () => controls.list ? controls.list() : new Map(listeners),
    commandLines: async (pids, options) => {
      if (controls.commands) return controls.commands(pids, options)
      return new Map(pids.map((pid) => [pid, commands.get(pid) ?? '']))
    },
    tcpProbe: async (_host, port) => controls.tcp ? controls.tcp(port) : listeners.has(port),
    waitForPortListening: async (port) => controls.waitListening ? controls.waitListening(port) : listeners.has(port),
    waitForPortFree: async (port) => controls.waitFree ? controls.waitFree(port) : !listeners.has(port),
    killTree: async (pid) => { kills.push(pid); for (const [port, owner] of listeners) if (owner === pid) listeners.delete(port) },
  }
  const ctx = { subprocess: { spawn(spec) {
    // DSH 0.2.2 SubprocessCollect is an object with maxBytes, not {mode:'collect'}.
    for (const stream of ['stdout', 'stderr']) {
      assert.deepEqual(Object.keys(spec.stdio[stream]).sort(), ['maxBytes', 'spill'])
      assert.ok(spec.stdio[stream].maxBytes > 0)
      assert.ok(spec.stdio[stream].spill.maxBytes > 0)
    }
    if (controls.spawn) return controls.spawn(spec)
    const done = deferred()
    const pid = 1000 + handles.length
    const current = readConfig(configPath).services.find((entry) => spec.argv.join(' ').includes(entry.command)) ?? definition
    if (current.port !== null) listeners.set(current.port, pid)
    commands.set(pid, 'node service.mjs')
    const handle = {
      done: done.promise, settle: done.resolve, reject: done.reject, terminated: false,
      terminate() { this.terminated = true; if (listeners.get(current.port) === pid) listeners.delete(current.port) },
      async waitForExit() { if (controls.waitExit) return controls.waitExit() },
    }
    handles.push(handle)
    return handle
  } } }
  const make = () => createManager({ ctx, configPath, stateDir: dir, logDir: dir, io })
  const manager = make()
  t.after(async () => { await manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  const raw = () => JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const patch = (fn) => { const value = raw(); fn(value); fs.writeFileSync(configPath, JSON.stringify(value)) }
  return { manager, make, configPath, definition, listeners, commands, handles, kills, controls, raw, patch }
}

for (const initial of [undefined, false, true]) test('start/stop persistent intent from ' + initial, async (t) => {
  const f = fixture(t, { autostart: initial })
  const started = await f.manager.start('one')
  assert.equal(f.raw().services[0].autostart, true)
  assert.equal(started.operation.status, 'started')
  assert.equal(started.operation.configRevision, readConfig(f.configPath).revision)
  await f.manager.start('one')
  assert.equal(f.handles.length, 1)
  await f.manager.stop('one')
  await f.manager.stop('one')
  assert.equal(f.raw().services[0].autostart, false)
})

test('already-running start commits true and verifies fresh identity', async (t) => {
  const f = fixture(t)
  f.listeners.set(4999, 88); f.commands.set(88, 'node service.mjs')
  f.controls.commands = async (pids, options) => { if (options?.fresh) assert.equal(options.fresh, true); return new Map(pids.map((pid) => [pid, f.commands.get(pid)])) }
  const result = await f.manager.start('one')
  assert.equal(result.operation.status, 'already-running')
  assert.equal(f.raw().services[0].autostart, true)
  assert.equal(f.handles.length, 0)
})

test('policy write preserves entire latest file including advanced and unrelated fields', async (t) => {
  const f = fixture(t, { port: null, host: 'localhost', url: 'http://example.test/', env: { X: 'Y' }, probe: { path: '/ready', expectStatus: 204, intervalMs: 900 }, extension: { retained: true } })
  f.patch((raw) => { raw.extension = ['retained']; raw.services.push({ id: 'two', cwd: '.', command: 'other', autostart: true, env: { Z: 'W' } }) })
  const before = f.raw()
  await f.manager.start('one')
  before.services[0].autostart = true
  assert.deepEqual(f.raw(), before)
  await Promise.all([f.manager.stop('one'), f.manager.stop('two')])
  assert.deepEqual(f.raw().services.map((s) => s.autostart), [false, false])
})

test('bad entries reject policy and registration, never discard invalid entries or perform I/O', async (t) => {
  const f = fixture(t, {}, [{ id: 'broken' }])
  const before = fs.readFileSync(f.configPath, 'utf8')
  f.controls.list = () => { throw new Error('must not probe') }
  await assert.rejects(f.manager.start('one'), { code: 'CONFIG_INVALID' })
  await assert.rejects(f.manager.handle('config.upsert', { service: { id: 'new', command: 'x', cwd: '.' } }), { code: 'CONFIG_INVALID' })
  await assert.rejects(f.manager.handle('config.remove', { id: 'one' }), { code: 'CONFIG_INVALID' })
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before)
  assert.equal(f.handles.length, 0)
})

test('save failure precedes all process I/O', async (t) => {
  const f = fixture(t)
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('disk unavailable') }
  try { await assert.rejects(f.manager.start('one'), /disk unavailable/) } finally { fs.renameSync = rename }
  assert.equal(f.handles.length, 0)
  assert.notEqual(f.raw().services[0].autostart, true)
})

test('revision conflict during synchronous policy commit does not spawn', async (t) => {
  const f = fixture(t)
  const original = fs.readFileSync
  let reads = 0
  fs.readFileSync = function(file, ...args) {
    if (file === f.configPath && ++reads === 3) fs.writeFileSync(file, JSON.stringify({ version: 1, services: [{ ...f.definition, title: 'external edit' }] }))
    return original.call(this, file, ...args)
  }
  try { await assert.rejects(f.manager.start('one'), { code: 'CONFIG_CONFLICT' }) } finally { fs.readFileSync = original }
  assert.equal(f.handles.length, 0)
  assert.equal(f.raw().services[0].title, 'external edit')
})

test('spawn failure preserves enabled intent and exposes committed revision', async (t) => {
  const f = fixture(t)
  f.controls.spawn = () => { throw new Error('spawn failed') }
  await assert.rejects(f.manager.start('one'), (error) => {
    assert.equal(error.code, 'OPERATION_FAILED')
    assert.deepEqual(error.details, { policyCommitted: true, autostart: true, configRevision: readConfig(f.configPath).revision })
    return true
  })
  assert.equal(f.raw().services[0].autostart, true)
})

for (const pattern of ['', 'expected']) test('force never bypasses signature ' + JSON.stringify(pattern), async (t) => {
  const f = fixture(t, { takeover: 'force', match: { commandLinePattern: pattern }, autostart: true })
  f.listeners.set(4999, 88); f.commands.set(88, 'unrelated')
  await assert.rejects(f.manager.start('one'), { code: 'PORT_OWNED_BY_OTHER' })
  await assert.rejects(f.manager.stop('one', { force: true }), (error) => error.code === 'PORT_OWNED_BY_OTHER' && error.details.policyCommitted && error.details.autostart === false)
  assert.equal(f.raw().services[0].autostart, false)
  assert.equal(f.listeners.get(4999), 88)
  assert.equal(f.kills.length, 0)
  assert.equal(f.handles.length, 0)
})

test('timeout is failure, keeps intent, repeated start does not duplicate handle', async (t) => {
  const f = fixture(t)
  f.controls.waitListening = async () => { f.listeners.clear(); return false }
  await assert.rejects(f.manager.start('one'), { code: 'TIMEOUT' })
  await assert.rejects(f.manager.start('one'), { code: 'TIMEOUT' })
  assert.equal(f.raw().services[0].autostart, true)
  assert.equal(f.handles.length, 1)
})

test('our handle is not evidence of listener identity', async (t) => {
  const f = fixture(t)
  f.controls.waitListening = async () => { f.listeners.set(4999, 99); f.commands.set(99, 'unrelated'); return true }
  await assert.rejects(f.manager.start('one'), { code: 'PORT_OWNED_BY_OTHER' })
  assert.equal(f.kills.length, 0)
})

test('instance exit while confirming listening cannot report success', async (t) => {
  const f = fixture(t)
  f.controls.waitListening = async () => { f.handles[0].settle({ exitCode: 1 }); await turn(); return true }
  await assert.rejects(f.manager.start('one'), { code: 'OPERATION_FAILED' })
})

for (const value of [false, true, undefined]) test('restart preserves exact original policy ' + value, async (t) => {
  const f = fixture(t, { autostart: value })
  const before = fs.readFileSync(f.configPath, 'utf8')
  await f.manager.restart('one')
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before)
})

test('restart holds full queue transaction and late old done never changes new handle', async (t) => {
  const f = fixture(t, { port: null })
  await f.manager.start('one')
  const gate = deferred()
  f.controls.waitExit = () => gate.promise
  const restart = f.manager.restart('one')
  const stop = f.manager.stop('one')
  await turn()
  assert.equal(f.raw().services[0].autostart, true, 'stop must not commit during restart')
  gate.resolve()
  await restart
  await stop
  assert.equal(f.handles.length, 2)
  assert.equal(f.handles[1].terminated, true)
  await f.manager.start('one')
  f.handles[0].settle({ exitCode: 99 }); f.handles[1].reject(new Error('late failure'))
  await turn()
  const result = await f.manager.start('one')
  assert.equal(f.handles.length, 3)
  assert.equal(result.services.find((s) => s.id === 'one').lastError, null)
  assert.equal(result.operation.status, 'dispatched')
})

test('ordinary supervisor mode and built-in dsh restart never schedule host', async (t) => {
  const f = fixture(t, { restartMode: 'supervisor' })
  await assert.rejects(f.manager.restart('one'), { code: 'OPERATION_FAILED' })
  await assert.rejects(f.manager.restart('dsh'), { code: 'OPERATION_FAILED' })
  f.listeners.set(4999, process.pid); f.commands.set(process.pid, 'node service.mjs')
  await assert.rejects(f.manager.stop('one'), { code: 'OPERATION_FAILED' })
  assert.equal(f.kills.length, 0)
  assert.equal(f.handles.length, 0)
})

test('recovery rechecks false policy after queued stop and continues to next service', async (t) => {
  const f = fixture(t, { autostart: true }, [{ id: 'two', command: 'other', cwd: '.', autostart: true }])
  const stopped = f.manager.stop('one')
  const recovery = f.manager.autostart()
  await Promise.all([stopped, recovery])
  assert.equal(f.raw().services[0].autostart, false)
  assert.equal(f.handles.length, 1, 'only second service dispatched')
})

for (const action of ['disable', 'delete', 'dispose']) test('recovery rechecks ' + action + ' after asynchronous probe', async (t) => {
  const f = fixture(t, { autostart: true })
  const gate = deferred()
  f.controls.list = () => gate.promise
  const recovery = f.manager.autostart()
  await turn()
  if (action === 'disable') f.patch((raw) => { raw.services[0].autostart = false })
  if (action === 'delete') f.patch((raw) => { raw.services = [] })
  if (action === 'dispose') await f.manager.dispose()
  gate.resolve(new Map())
  await recovery
  assert.equal(f.handles.length, 0)
})

test('dispose during manual probe and queued start prevents late spawn', async (t) => {
  const f = fixture(t)
  const gate = deferred()
  f.controls.list = () => gate.promise
  const first = f.manager.start('one')
  const second = f.manager.start('one')
  const rejected = [assert.rejects(first, (e) => e.code === 'MANAGER_DISPOSED' && e.details.policyCommitted), assert.rejects(second, { code: 'MANAGER_DISPOSED' })]
  await turn(); await f.manager.dispose(); gate.resolve(new Map())
  await Promise.all(rejected)
  assert.equal(f.handles.length, 0)
  assert.equal(f.raw().services[0].autostart, true)
})

test('dispose after spawn cleans own instance even if definition removed', async (t) => {
  const f = fixture(t)
  const gate = deferred()
  f.controls.waitListening = () => gate.promise
  const pending = f.manager.start('one')
  const rejected = assert.rejects(pending, { code: 'MANAGER_DISPOSED' })
  await turn()
  f.patch((raw) => { raw.services = [] })
  await f.manager.dispose()
  gate.resolve(true)
  await rejected
  assert.equal(f.handles[0].terminated, true)
})

test('new manager over same config recovers only true; stop persists across reconstruction', async (t) => {
  const f = fixture(t, { port: null })
  await f.manager.start('one')
  await f.manager.dispose()
  const next = f.make()
  await next.autostart()
  assert.equal(f.handles.length, 2)
  await next.stop('one')
  await next.dispose()
  const last = f.make()
  await last.autostart()
  assert.equal(f.handles.length, 2)
  await last.dispose()
})

for (const operation of ['start', 'stop']) test(operation + ' probe errors preserve intent without claiming absence', async (t) => {
  const f = fixture(t)
  f.listeners.set(4999, 88); f.commands.set(88, 'node service.mjs')
  f.controls.list = () => { throw new Error('netstat failed') }
  await assert.rejects(f.manager[operation]('one'), (error) => error.details.policyCommitted && error.details.autostart === (operation === 'start'))
  assert.equal(f.handles.length, 0)
  assert.equal(f.kills.length, 0)
  assert.equal(f.listeners.get(4999), 88)
})

test('stop wait failure never reports success and retains false', async (t) => {
  const f = fixture(t)
  f.listeners.set(4999, 88); f.commands.set(88, 'node service.mjs')
  f.controls.waitFree = () => { throw new Error('netstat failed during release confirmation') }
  await assert.rejects(f.manager.stop('one'), (error) => error.details.policyCommitted && error.details.autostart === false)
  assert.equal(f.raw().services[0].autostart, false)
})

test('unconfirmed handle exit is not a successful stop', async (t) => {
  const f = fixture(t, { port: null })
  await f.manager.start('one')
  f.controls.waitExit = async () => false
  await assert.rejects(f.manager.stop('one'), { code: 'TIMEOUT' })
  assert.equal(f.raw().services[0].autostart, false)
})

for (const operation of ['start', 'restart']) test('dispose during final ' + operation + ' snapshot rejects success', async (t) => {
  const f = fixture(t, { port: null })
  const gate = deferred()
  f.controls.tcp = () => gate.promise
  const pending = f.manager[operation]('one')
  const rejected = assert.rejects(pending, (e) => e.code === 'MANAGER_DISPOSED' && (operation !== 'start' || e.details.policyCommitted))
  await turn()
  assert.equal(f.handles.length, 1)
  await f.manager.dispose()
  gate.resolve(false)
  await rejected
  assert.equal(f.handles[0].terminated, true)
})

test('recovery failure does not prevent later true service, false and omitted skipped', async (t) => {
  const f = fixture(t, { autostart: true }, [
    { id: 'two', command: 'other', cwd: '.', autostart: true },
    { id: 'three', command: 'disabled', cwd: '.', autostart: false },
    { id: 'four', command: 'omitted', cwd: '.' },
  ])
  const before = fs.readFileSync(f.configPath, 'utf8')
  f.listeners.set(4999, 88); f.commands.set(88, 'unrelated')
  await f.manager.autostart()
  assert.equal(f.handles.length, 1)
  assert.equal(f.kills.length, 0)
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before)
})

test('recovery revalidates edited definition before accepting old signed listener', async (t) => {
  const f = fixture(t, { autostart: true })
  f.listeners.set(4999, 88); f.commands.set(88, 'node service.mjs')
  const gate = deferred()
  let blocked = false
  f.controls.commands = async (pids) => {
    if (!blocked) { blocked = true; await gate.promise }
    return new Map(pids.map((pid) => [pid, f.commands.get(pid)]))
  }
  const recovery = f.manager.autostart()
  await turn()
  f.patch((raw) => { raw.services[0].port = 4998 })
  gate.resolve()
  await recovery
  assert.equal(f.handles.length, 1)
  assert.equal(f.listeners.has(4998), true)
  assert.equal(f.listeners.get(4999), 88)
})

test('natural exit keeps true policy and does not claim external listener ownership', async (t) => {
  const f = fixture(t)
  await f.manager.start('one')
  f.handles[0].settle({ exitCode: 1 })
  await turn()
  f.listeners.set(4999, 88); f.commands.set(88, 'unrelated')
  const result = await f.manager.snapshot()
  assert.equal(result.services.find((s) => s.id === 'one').ownership, 'discovered')
  assert.equal(f.raw().services[0].autostart, true)
})
