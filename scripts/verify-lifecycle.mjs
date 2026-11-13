/**
 * 真实子进程/端口验证：手动 start → 重建 manager 恢复 → stop → 重建不恢复。
 * 始终复用同一临时 services.json；不操作 DSH、不加载 restart-supervisor。
 * 用法：node scripts/verify-lifecycle.mjs [scratchPort]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listListeners } from '../src/probe.mjs'
import { createManager } from '../src/supervisor.mjs'
import { createFakeSeam, sleep } from './fake-seam.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratchPort = Number(process.argv[2] ?? 4598)
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-lifecycle-'))
const configPath = path.join(stateDir, 'services.json')
const logDir = path.join(stateDir, 'logs')
const record = (step, data) => console.log('[' + step + '] ' + JSON.stringify(data))
const policy = () => JSON.parse(fs.readFileSync(configPath, 'utf8')).services[0].autostart
const managers = []
function rebuild() {
  const { ctx } = createFakeSeam({ configPath, stateDir, logDir })
  const manager = createManager({ ctx, configPath, stateDir, logDir })
  managers.push(manager)
  return manager
}
async function waitPort(present) {
  const deadline = Date.now() + 15_000
  do {
    if ((await listListeners()).has(scratchPort) === present) return true
    await sleep(250)
  } while (Date.now() < deadline)
  return false
}

fs.writeFileSync(configPath, JSON.stringify({ version: 1, services: [{
  id: 'scratch-auto', title: 'Scratch persistent lifecycle', port: scratchPort,
  command: 'node "' + path.join(here, 'scratch-server.mjs') + '" ' + scratchPort,
  cwd: here, autoStopOnExit: true,
  match: { commandLinePattern: 'scratch-server\\.mjs' },
}] }, null, 2))
assert.equal((await listListeners()).has(scratchPort), false, '验证端口必须先空闲')

try {
  let manager = rebuild()
  await manager.autostart()
  assert.equal((await listListeners()).has(scratchPort), false, '缺省策略不恢复')
  const started = await manager.start('scratch-auto')
  assert.equal(policy(), true)
  assert.equal(started.operation.status, 'started')
  const firstPid = (await listListeners()).get(scratchPort)
  assert.ok(firstPid)
  record('start.persisted', { firstPid, autostart: policy(), configPath })

  await manager.dispose()
  assert.equal(await waitPort(false), true)
  assert.equal(policy(), true, '卸载不改意图')
  manager = rebuild()
  await manager.autostart()
  const restoredPid = (await listListeners()).get(scratchPort)
  assert.ok(restoredPid)
  assert.notEqual(restoredPid, firstPid)
  await Promise.all([manager.start('scratch-auto'), manager.start('scratch-auto')])
  assert.equal((await listListeners()).get(scratchPort), restoredPid, '重复 start 不重复派发')
  record('rebuild.restored', { restoredPid, autostart: policy() })

  await manager.stop('scratch-auto')
  assert.equal(policy(), false)
  assert.equal(await waitPort(false), true)
  await manager.dispose()
  manager = rebuild()
  await manager.autostart()
  assert.equal((await listListeners()).has(scratchPort), false)
  assert.equal(policy(), false)
  record('rebuild.disabled', { listening: false, autostart: policy() })

  await manager.restart('scratch-auto')
  const beforeRestart = (await listListeners()).get(scratchPort)
  assert.ok(beforeRestart)
  const beforeRaw = fs.readFileSync(configPath, 'utf8')
  await manager.restart('scratch-auto')
  const afterRestart = (await listListeners()).get(scratchPort)
  assert.ok(afterRestart)
  assert.notEqual(afterRestart, beforeRestart)
  assert.equal(policy(), false, 'restart 保持 false')
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeRaw, 'restart 不写配置')
  record('restart.preserved', { beforeRestart, afterRestart, autostart: policy() })
  await manager.dispose()
  assert.equal(await waitPort(false), true)
  manager = rebuild()
  await manager.autostart()
  assert.equal((await listListeners()).has(scratchPort), false, 'restart 没有偷偷开启恢复')
  record('final', { listening: false, autostart: policy(), managers: managers.length })
  console.log('PASS')
} finally {
  // 仅清理本测试自己持有的 handle，绝不按端口盲杀其它进程。
  for (const manager of managers) await manager.dispose()
  assert.equal(await waitPort(false), true, '测试进程必须退出')
  fs.rmSync(stateDir, { recursive: true, force: true })
}
