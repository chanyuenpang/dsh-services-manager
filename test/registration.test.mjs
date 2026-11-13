import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../src/supervisor.mjs'
import { readConfig } from '../src/config.mjs'

function fixture(t, document = { version: 1, services: [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-register-'))
  const configPath = path.join(dir, 'services.json')
  fs.writeFileSync(configPath, JSON.stringify(document))
  const manager = createManager({ configPath, stateDir: dir, logDir: dir, ctx: { subprocess: { spawn() { throw Error('registration must not spawn') } } } })
  t.after(async () => { await manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  const get = () => readConfig(configPath)
  const register = (service, expectedRevision = get().revision) => manager.handle('config.upsert', { registration: true, service, expectedRevision })
  return { manager, register, get, raw: () => JSON.parse(get().raw), configPath }
}
const service = { id: 'API.Mixed_' + 'x'.repeat(70), command: 'node app.mjs', cwd: 'C:/Services/My API', port: 4567, match: { commandLinePattern: 'app[.]mjs' } }

test('strict stable registration creates once, never starts, preserves omitted raw fields and nested keys', async (t) => {
  const f = fixture(t, { version: 7, extension: true, services: [] })
  const first = await f.register(service)
  assert.equal(first.id, service.id)
  assert.equal(first.configRevision, f.get().revision)
  assert.equal(f.raw().services[0].autostart, false)
  const again = await f.register(service)
  assert.equal(again.revision, first.revision)
  await f.register({ id: service.id, host: 'localhost', url: 'http://localhost:4567/custom', env: { A: 'one', B: 'two' }, probe: { path: '/ready', expectStatus: 204, intervalMs: 700 } })
  const before = f.raw()
  await f.register({ id: service.id, title: 'Renamed', env: { A: 'changed' }, probe: { path: '/health' } })
  before.services[0].title = 'Renamed'; before.services[0].env.A = 'changed'; before.services[0].probe.path = '/health'
  assert.deepEqual(f.raw(), before)
  assert.equal(f.raw().services.length, 1)
})

test('host rejects malformed ids, unknown fields, bad core fields, missing revision without writes', async (t) => {
  const f = fixture(t)
  const original = f.get().raw
  const invalid = [
    { ...service, id: 'Name With Spaces' }, { ...service, id: 'trim ' }, { ...service, id: 'dsh' }, { ...service, id: '' },
    { ...service, id: undefined }, { ...service, typo: true }, { ...service, match: { typo: 'x' } },
    { ...service, probe: { typo: 200 } }, { ...service, match: { commandLinePattern: '[' } },
    { ...service, match: { commandLinePattern: '' } }, { ...service, port: null }, { ...service, port: '4567' },
    { ...service, command: undefined }, { ...service, cwd: undefined }, { ...service, port: undefined }, { ...service, match: undefined },
    { ...service, takeover: 'force' }, { ...service, restartMode: 'supervisor' }, { ...service, env: { X: 1 } },
  ]
  for (const value of invalid) {
    await assert.rejects(f.register(value), { code: 'CONFIG_INVALID' })
    assert.equal(f.get().raw, original)
  }
  await assert.rejects(f.manager.handle('config.upsert', { registration: true, service }), { code: 'CONFIG_INVALID' })
  await f.register(service)
  for (const patch of [{ port: null }, { command: '' }, { cwd: '' }, { match: { commandLinePattern: '' } }]) await assert.rejects(f.register({ id: service.id, ...patch }), { code: 'CONFIG_INVALID' })
})

test('host revision rejects stale concurrent update/removal; omitted fields preserve latest advanced data', async (t) => {
  const f = fixture(t)
  await f.register(service)
  const revision = f.get().revision
  const results = await Promise.allSettled([f.register({ id: service.id, title: 'winner' }, revision), f.register({ id: service.id, title: 'loser' }, revision)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].reason.code, 'CONFIG_CONFLICT')
  await assert.rejects(f.manager.handle('config.remove', { id: service.id, expectedRevision: revision }), { code: 'CONFIG_CONFLICT' })
  await assert.rejects(f.manager.handle('config.remove', { id: service.id }), { code: 'CONFIG_INVALID' })
  assert.equal(f.raw().services[0].title, 'winner')
})

test('raw unrelated extension data survives form upsert/removal; form slug and inferred port remain', async (t) => {
  const other = { ...service, extension: { keep: true }, probe: { expectStatus: 204, intervalMs: 999 }, env: { X: 'Y' } }
  const f = fixture(t, { version: 9, extension: ['top'], services: [other] })
  const created = await f.manager.handle('config.upsert', { expectedRevision: f.get().revision, service: { title: 'UI Demo', command: 'node ui.mjs --port 4596', cwd: '.' } })
  assert.equal(created.id, 'ui-demo')
  assert.deepEqual(f.raw().services[0], other)
  assert.equal(f.raw().services[1].port, 4596)
  assert.equal(f.raw().services[1].url, 'http://127.0.0.1:4596/')
  await f.manager.handle('config.remove', { id: created.id, expectedRevision: f.get().revision })
  assert.deepEqual(f.raw(), { version: 9, extension: ['top'], services: [other] })
})

test('UI edits exact CLI id and can still clear a health path without resurrecting old fields', async (t) => {
  const f = fixture(t)
  await f.register({ ...service, probe: { path: '/ready', expectStatus: 204 }, host: 'localhost' })
  const revision = f.get().revision
  await f.manager.handle('config.upsert', { expectedRevision: revision, service: { id: service.id, title: 'UI renamed', probe: { path: '' } } })
  assert.equal(f.raw().services.length, 1)
  assert.equal(f.raw().services[0].id, service.id)
  assert.equal(f.get().services[0].probe.path, null)
  assert.equal(f.get().services[0].host, '127.0.0.1')
})

test('bad entries reject strict registration/removal intact; existing user file is never reseeded', async (t) => {
  const f = fixture(t, { version: 1, services: [service, { id: 'broken' }] })
  const original = f.get().raw
  await assert.rejects(f.register({ id: service.id, title: 'new' }), { code: 'CONFIG_INVALID' })
  await assert.rejects(f.manager.handle('config.remove', { id: service.id, expectedRevision: f.get().revision }), { code: 'CONFIG_INVALID' })
  assert.equal(f.get().raw, original)
})
