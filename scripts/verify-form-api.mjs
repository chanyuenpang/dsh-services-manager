/**
 * 表单配置 API 的真机验证（不重启 dsh）：config.upsert → 文件真的有 → start/stop → config.remove → 文件真的没了。
 *
 * 为什么单独验：表单是新的用户入口，它绕过「整份 JSON 编辑」直接改单条定义，
 * 必须证明「文件是唯一真相」这条不变量没被破坏，且并发的 expectedRevision 仍然生效。
 *
 * 用法：node scripts/verify-form-api.mjs [scratchPort]
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
const scratchPort = Number(process.argv[2] ?? 4597)
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-form-'))
const configPath = path.join(stateDir, 'services.json')
const logDir = path.join(stateDir, 'logs')
const record = (step, data) => console.log(`[${step}] ${JSON.stringify(data)}`)

const readServices = () => JSON.parse(fs.readFileSync(configPath, 'utf8')).services

const { ctx, invoke, pluginConfig, disposers } = createFakeSeam({ configPath, stateDir, logDir })
apply(ctx, pluginConfig)

async function waitPort(port, present, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await listListeners()).has(port) === present) return true
    if (Date.now() >= deadline) return false
    await sleep(250)
  }
}

try {
  const initial = await invoke('config.get')
  assert.equal(readServices().length, 2, '默认配置应有两条服务')
  record('baseline', { revision: initial.revision, services: readServices().map((entry) => entry.id) })

  // 1) 表单新增：只提交一条定义，其余条目必须原样保留
  const created = await invoke('config.upsert', {
    expectedRevision: initial.revision,
    service: {
      title: 'Scratch 表单服务',
      port: scratchPort,
      command: `node "${path.join(here, 'scratch-server.mjs')}" ${scratchPort}`,
      cwd: here,
      autostart: false,
      autoStopOnExit: true,
      match: { commandLinePattern: 'scratch-server\\.mjs' },
    },
  })
  const afterCreate = readServices()
  const added = afterCreate.find((entry) => entry.port === scratchPort)
  assert.ok(added !== undefined, '新增的服务必须真的落进配置文件')
  assert.equal(added.id, created.id, '宿主必须回传生成的 id')
  assert.match(added.id, /^[a-z0-9._-]+$/, 'id 必须只含合法字符')
  assert.ok(added.id.startsWith('scratch'), 'id 应由名称派生（中文会被剥离，故这里是 scratch）')
  assert.equal(afterCreate.length, 3, '新增不得丢掉原有条目')
  record('config.upsert', { id: created.id, revision: created.revision, services: afterCreate.map((entry) => entry.id) })

  // 2) 过期 revision 必须被拒（表单同样受并发保护）
  let conflict = null
  try {
    await invoke('config.upsert', { expectedRevision: initial.revision, service: { title: 'x', command: 'node x.mjs', cwd: here } })
  } catch (error) {
    conflict = error
  }
  assert.equal(conflict?.code, 'CONFIG_CONFLICT', '过期 revision 必须返回 CONFIG_CONFLICT')
  assert.equal(readServices().length, 3, '冲突时文件不得被改动')
  record('config.conflict', { code: conflict.code, servicesUnchanged: readServices().length })

  // 3) 用表单建出来的服务必须真的能被启动/停止
  const started = await invoke('start', { id: created.id })
  assert.equal(started.services.find((service) => service.id === created.id).status, 'running')
  assert.ok((await listListeners()).has(scratchPort), 'start 之后端口必须监听')
  const stopped = await invoke('stop', { id: created.id })
  assert.equal(stopped.services.find((service) => service.id === created.id).status, 'stopped')
  assert.ok(!(await listListeners()).has(scratchPort), 'stop 之后端口必须释放')
  record('start/stop', { port: scratchPort, ok: true })

  // 4) 表单编辑：改标题 + 关掉自动启动，其余字段保留
  const edited = await invoke('config.upsert', {
    expectedRevision: created.revision,
    service: { id: created.id, title: 'Scratch 改名后', port: scratchPort, command: `node "${path.join(here, 'scratch-server.mjs')}" ${scratchPort}`, cwd: here, autostart: false, autoStopOnExit: false, match: { commandLinePattern: 'scratch-server\\.mjs' } },
  })
  const afterEdit = readServices().find((entry) => entry.id === created.id)
  assert.equal(afterEdit.title, 'Scratch 改名后')
  assert.equal(afterEdit.autoStopOnExit, false)
  assert.equal(readServices().length, 3, '编辑不得改变条目数量')
  record('config.upsert.edit', { id: created.id, revision: edited.revision, autoStopOnExit: afterEdit.autoStopOnExit })

  // 5) 表单删除：条目消失，且不影响其它条目
  await invoke('config.remove', { id: created.id, expectedRevision: edited.revision })
  const afterRemove = readServices()
  assert.equal(afterRemove.length, 2, '删除后应回到两条')
  assert.ok(!afterRemove.some((entry) => entry.id === created.id), '被删条目必须消失')
  record('config.remove', { services: afterRemove.map((entry) => entry.id) })

  // 6) 删除不存在的 id 必须如实报错
  let missing = null
  try {
    await invoke('config.remove', { id: 'not-there', expectedRevision: null })
  } catch (error) {
    missing = error
  }
  assert.equal(missing?.code, 'SERVICE_NOT_FOUND', '删除不存在的服务必须报 SERVICE_NOT_FOUND')
  record('config.remove.missing', { code: missing.code })

  console.log('PASS')
} finally {
  const leftover = (await listListeners()).get(scratchPort)
  if (leftover !== undefined) spawn('taskkill', ['/PID', String(leftover), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  for (const dispose of disposers) {
    try { await dispose() } catch { /* 收尾失败不影响结论 */ }
  }
}
