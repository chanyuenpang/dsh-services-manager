/**
 * 宿主半边的真机验证（不重启 dsh）。
 *
 * 做法：用最小的 subprocess seam 替身驱动真实的 `src/index.mjs`，拿到真实的 RPC 处理器，
 * 然后对**本机真实端口/PID**做核对：snapshot 必须与 `netstat` 一致；start/stop 必须让真实
 * 端口真的起落；签名不匹配的占用者必须被拒绝且进程存活；配置写入必须遵守 revision。
 *
 * 用法：node scripts/verify-host.mjs [scratchPort]
 * 输出：每步一行 JSON（[步骤] {...}），最后 PASS 或抛错失败。
 *
 * 注意：本脚本的 `process.pid` 是脚本自己的 pid，所以内置 `dsh` 条目的 pid 在证据里
 * 显示的是脚本 pid；真实运行时该条目展示的是 dsh 自己。端口一侧不受影响。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { commandLines, listListeners } from '../src/probe.mjs'
import { apply } from '../src/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratchPort = Number(process.argv[2] ?? 4599)
const unrelatedPort = 4173
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-verify-'))
const configPath = path.join(stateDir, 'services.json')
const logDir = path.join(stateDir, 'logs')

const handlers = new Map()
const disposers = []
let scratchPid = null

function makeReader(stream) {
  let text = ''
  stream.on('data', (chunk) => { text += String(chunk) })
  return { readFrom: (from) => ({ text: text.slice(from), nextOffset: text.length }) }
}

/** DSH subprocess seam 的最小替身：真实启动子进程，并暴露 collected/done/terminate/waitForExit。 */
const ctx = {
  config: { configPath, stateDir, logDir },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  get(name) {
    if (name !== 'connection') return undefined
    return {
      rpc: {
        handle(channel, handler) {
          handlers.set(channel, handler)
          return () => handlers.delete(channel)
        },
      },
    }
  },
  subprocess: {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let settled = false
      const done = new Promise((resolve) => {
        child.on('close', (code, signal) => { settled = true; resolve({ exitCode: code, signal }) })
      })
      return {
        collected: { stdout: makeReader(child.stdout), stderr: makeReader(child.stderr) },
        done,
        terminate() {
          try {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          } catch { /* 进程可能已消失 */ }
        },
        async waitForExit() {
          for (let index = 0; index < 60 && !settled; index += 1) await new Promise((r) => setTimeout(r, 100))
          return settled
        },
      }
    },
  },
}

const record = (step, data) => console.log(`[${step}] ${JSON.stringify(data)}`)
const brief = (service) => ({
  id: service.id, port: service.port, status: service.status,
  ownership: service.ownership, pid: service.pid, lastError: service.lastError ?? null,
})

apply(ctx, { configPath, stateDir, logDir })
const call = handlers.get('/dsh-services')
assert.ok(typeof call === 'function', 'RPC 通道 /dsh-services 未注册')

async function invoke(endpoint, payload) {
  const result = await call(endpoint, payload)
  if (result?.ok !== true) {
    const error = new Error(result?.error?.message ?? 'RPC 失败')
    error.code = result?.error?.code
    error.details = result?.error?.details
    throw error
  }
  return result.value
}

async function refusal(endpoint, payload) {
  try {
    await invoke(endpoint, payload)
    return null
  } catch (error) {
    return error
  }
}

try {
  // 1) 真实基线：snapshot 必须与 netstat 一致
  const listeners = listListeners()
  const snapshot = await invoke('snapshot')
  record('snapshot', {
    revision: snapshot.revision,
    configPath: snapshot.configPath,
    summary: snapshot.summary,
    services: snapshot.services.map(brief),
  })
  for (const service of snapshot.services) {
    if (service.port === null) continue
    const expected = listeners.has(service.port) ? 'running' : 'stopped'
    assert.equal(service.status, expected, `${service.id} 状态必须与 netstat 一致（期望 ${expected}）`)
    // 本脚本不是 dsh，所以内置 dsh 条目的 pid 是脚本自己的 pid；真实运行时才是 dsh 自己。
    if (expected === 'running' && service.id !== 'dsh') {
      assert.equal(service.pid, listeners.get(service.port), `${service.id} pid 必须等于端口占用者`)
    }
  }
  assert.equal(snapshot.services.filter((service) => service.id === 'dsh').length, 1, '必须存在内置 dsh 条目')
  assert.equal(snapshot.services.find((service) => service.id === 'dsh').managed, false, 'dsh 条目不可管理')
  record('snapshot.verified', { checked: snapshot.services.length, netstatPorts: [...listeners.keys()].length })

  // 2) 配置读写：revision 冲突必须拒绝，且文件不被覆盖
  const configBefore = await invoke('config.get')
  const rawWithScratch = JSON.stringify({
    version: 1,
    services: [{
      id: 'scratch',
      title: 'Scratch HTTP（验证用）',
      port: scratchPort,
      url: `http://127.0.0.1:${scratchPort}/`,
      command: `node "${path.join(here, 'scratch-server.mjs')}" ${scratchPort}`,
      cwd: here,
      autostart: false,
      autoStopOnExit: true,
      match: { commandLinePattern: 'scratch-server\\.mjs' },
    }],
  }, null, 2)
  const saved = await invoke('config.set', { raw: rawWithScratch, expectedRevision: configBefore.revision })
  record('config.set', { path: saved.path, revision: saved.revision })
  const conflict = await refusal('config.set', { raw: configBefore.raw, expectedRevision: configBefore.revision })
  assert.equal(conflict?.code, 'CONFIG_CONFLICT', '过期 revision 必须返回 CONFIG_CONFLICT')
  assert.equal(fs.readFileSync(configPath, 'utf8'), saved.raw, '冲突时配置文件不得被覆盖')
  record('config.conflict', { code: conflict.code, fileIntact: true })

  const invalid = await refusal('config.set', { raw: '{"version":1,"services":[{"id":"x"}]}', expectedRevision: saved.revision })
  assert.equal(invalid?.code, 'CONFIG_INVALID', '无效定义必须返回 CONFIG_INVALID')
  record('config.invalid', { code: invalid.code })

  // 3) start：真实端口必须起来，且能读到真实命令行
  assert.equal(listeners.has(scratchPort), false, `验证端口 ${scratchPort} 必须先空闲（否则先停掉它）`)
  const started = await invoke('start', { id: 'scratch' })
  const scratchRunning = started.services.find((service) => service.id === 'scratch')
  const afterStart = listListeners()
  const startLogs = await invoke('logs', { id: 'scratch', lines: 40 })
  record('start.raw', { ...brief(scratchRunning), listening: afterStart.has(scratchPort), output: startLogs.text.slice(0, 400) })
  assert.equal(afterStart.has(scratchPort), true, `start 之后端口必须进入监听（状态 ${scratchRunning.status}，lastError ${scratchRunning.lastError}）`)
  scratchPid = afterStart.get(scratchPort)
  assert.equal(scratchRunning.status, 'running')
  assert.equal(scratchRunning.ownership, 'spawned')
  record('start', { ...brief(scratchRunning), commandLine: commandLines([scratchPid]).get(scratchPid) })
  const logs = await invoke('logs', { id: 'scratch', lines: 20 })
  record('logs', { path: logs.path, text: logs.text.trim().slice(0, 200) })

  // 4) stop：真实端口必须释放，且我们主动停止不算异常
  const stopped = await invoke('stop', { id: 'scratch' })
  const scratchStopped = stopped.services.find((service) => service.id === 'scratch')
  assert.equal(listListeners().has(scratchPort), false, 'stop 之后端口必须释放')
  assert.equal(scratchStopped.status, 'stopped', '主动停止后状态必须是 stopped（不是 error）')
  record('stop', brief(scratchStopped))

  // 5) 签名不匹配：拒绝终止且进程必须存活（借本机 4173 上的无关服务，只读不改）
  const unrelatedPid = listListeners().get(unrelatedPort)
  if (unrelatedPid !== undefined) {
    const guardRaw = JSON.stringify({
      version: 1,
      services: [{
        id: 'guard',
        title: 'Guard',
        port: unrelatedPort,
        command: 'node never-started.mjs',
        cwd: here,
        match: { commandLinePattern: 'definitely-not-this-service' },
      }],
    })
    const guardSaved = await invoke('config.set', { raw: guardRaw, expectedRevision: saved.revision })
    const denied = await refusal('stop', { id: 'guard' })
    assert.equal(denied?.code, 'PORT_OWNED_BY_OTHER', '签名不匹配必须返回 PORT_OWNED_BY_OTHER')
    assert.equal(listListeners().get(unrelatedPort), unrelatedPid, '签名不匹配时不得终止该进程')
    record('stop.refused', {
      code: denied.code, port: unrelatedPort, pidKeptAlive: unrelatedPid,
      details: { pid: denied.details?.pid, pattern: denied.details?.pattern },
      guardRevision: guardSaved.revision,
    })
  } else {
    record('stop.refused', { skipped: `端口 ${unrelatedPort} 上没有服务，跳过签名拒绝验证` })
  }

  console.log('PASS')
} finally {
  // 收尾：把验证用端口清干净（失败路径也要清），并释放 effect。
  const leftover = listListeners().get(scratchPort)
  if (leftover !== undefined) {
    spawn('taskkill', ['/PID', String(leftover), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  for (const dispose of disposers) {
    try {
      await dispose()
    } catch { /* 收尾失败不影响结论 */ }
  }
}
