/**
 * 生命周期真机验证（不重启 dsh）：autostart 拉起 → restart 换 PID → dispose 停止。
 *
 * 用法：node scripts/verify-lifecycle.mjs [scratchPort]
 * 证据：每步一行 JSON，最后 PASS。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listListeners } from '../src/probe.mjs'
import { apply } from '../src/index.mjs'
import { createFakeSeam, sleep } from './fake-seam.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratchPort = Number(process.argv[2] ?? 4598)
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-lifecycle-'))
const configPath = path.join(stateDir, 'services.json')
const logDir = path.join(stateDir, 'logs')

const record = (step, data) => console.log(`[${step}] ${JSON.stringify(data)}`)

async function waitPort(port, present, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (listListeners().has(port) === present) return true
    if (Date.now() >= deadline) return false
    await sleep(250)
  }
}

// 预置一条 autostart 服务：插件加载时应当被自动拉起。
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(configPath, `${JSON.stringify({
  version: 1,
  services: [{
    id: 'scratch-auto',
    title: 'Scratch autostart',
    port: scratchPort,
    url: `http://127.0.0.1:${scratchPort}/`,
    command: `node "${path.join(here, 'scratch-server.mjs')}" ${scratchPort}`,
    cwd: here,
    autostart: true,
    autoStopOnExit: true,
    match: { commandLinePattern: 'scratch-server\\.mjs' },
  }],
}, null, 2)}\n`, 'utf8')

assert.equal(listListeners().has(scratchPort), false, `验证端口 ${scratchPort} 必须先空闲`)

const { ctx, disposers, invoke, pluginConfig } = createFakeSeam({ configPath, stateDir, logDir })
apply(ctx, pluginConfig)

try {
  // 1) autostart：加载后端口必须真的起来
  const autoStarted = await waitPort(scratchPort, true, 15_000)
  const snapshot = await invoke('snapshot')
  const service = snapshot.services.find((item) => item.id === 'scratch-auto')
  record('autostart', { listening: autoStarted, ...brief(service) })
  assert.equal(autoStarted, true, 'autostart 服务必须在插件加载后自动监听端口')
  assert.equal(service.ownership, 'spawned', 'autostart 拉起的服务所有权必须是 spawned')
  assert.equal(service.autostart, true)

  // 2) restart：PID 必须变化
  const pidBefore = listListeners().get(scratchPort)
  const restarted = await invoke('restart', { id: 'scratch-auto' })
  const pidAfter = listListeners().get(scratchPort)
  record('restart', { pidBefore, pidAfter, status: restarted.services.find((item) => item.id === 'scratch-auto')?.status })
  assert.ok(Number.isInteger(pidAfter), 'restart 之后端口必须仍被监听')
  assert.notEqual(pidAfter, pidBefore, 'restart 之后 PID 必须变化')

  // 3) dispose：插件卸载（dsh 退出）时必须停止自己启动的实例
  for (const dispose of disposers) await dispose()
  const released = await waitPort(scratchPort, false, 15_000)
  record('dispose', { portReleased: released, pid: pidAfter })
  assert.equal(released, true, 'dispose 之后由本插件启动的实例必须被停止')

  console.log('PASS')
} finally {
  const leftover = listListeners().get(scratchPort)
  if (leftover !== undefined) {
    spawn('taskkill', ['/PID', String(leftover), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
}

function brief(service) {
  if (service === undefined) return {}
  return { id: service.id, port: service.port, status: service.status, ownership: service.ownership, pid: service.pid }
}
