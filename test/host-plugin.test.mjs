import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, inject } from '../src/index.mjs'

test('current Host contract declares route dependencies and awaits async disposers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-host-contract-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(inject, ['subprocess', 'connection', 'webServer'])
  const disposers = []
  let rpcDisposed = false
  const ctx = {
    subprocess: { spawn() { throw new Error('empty config must not spawn') } },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    get(key) {
      assert.equal(key, 'connection')
      return { rpc: { handle(channel) {
        assert.equal(channel, '/dsh-services')
        return async () => { await Promise.resolve(); rpcDisposed = true }
      } } }
    },
  }
  apply(ctx, { configPath: path.join(dir, 'services.json'), stateDir: dir, logDir: dir })
  assert.equal(disposers.length, 2)
  const rpcDone = disposers[1]()
  assert.equal(typeof rpcDone?.then, 'function', 'route disposal must be awaitable')
  await rpcDone
  assert.equal(rpcDisposed, true)
  const managerDone = disposers[0]()
  assert.equal(typeof managerDone?.then, 'function', 'service cleanup must be awaitable')
  await managerDone
})
