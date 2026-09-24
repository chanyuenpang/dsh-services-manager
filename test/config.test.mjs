/**
 * config.mjs 单测：条目级错误隔离、原子写、乐观并发冲突。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig, readConfig, revisionOf, saveConfig } from '../src/config.mjs'

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-test-'))
  return path.join(dir, 'services.json')
}

/** 捕获同步抛错（assert.throws 不返回错误对象）。 */
function capture(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('期望抛出错误，但没有')
}

test('parseConfig 非法 JSON 与顶层形状错误被隔离成 issue', () => {
  assert.equal(parseConfig('{oops').issues.length, 1)
  assert.equal(parseConfig('[]').issues[0].message.includes('对象'), true)
  assert.equal(parseConfig('{"services":{}}').issues[0].message.includes('数组'), true)
})

test('parseConfig 只隔离无效条目，不整体失败', () => {
  const raw = JSON.stringify({
    version: 1,
    services: [
      { id: 'ok', command: 'node x.mjs', cwd: 'C:/tmp' },
      { id: '', command: 'node y.mjs', cwd: 'C:/tmp' },
      { id: 'bad-port', command: 'node z.mjs', cwd: 'C:/tmp', port: 70000 },
      { id: 'ok', command: 'node again.mjs', cwd: 'C:/tmp' },
      { id: 'dsh', command: 'node reserved.mjs', cwd: 'C:/tmp' },
    ],
  })
  const { services, issues } = parseConfig(raw)
  assert.equal(services.length, 1)
  assert.equal(services[0].id, 'ok')
  assert.equal(services[0].url, null)
  assert.equal(services[0].autostart, false)
  assert.equal(services[0].autoStopOnExit, true)
  assert.equal(issues.length, 4)
})

test('readConfig 在缺失时写入默认配置并给出内容指纹', () => {
  const configPath = tempConfigPath()
  const config = readConfig(configPath)
  assert.equal(fs.existsSync(configPath), true)
  assert.equal(config.services.length, 2)
  assert.equal(config.issues.length, 0)
  assert.equal(config.revision, revisionOf(config.raw))
})

test('saveConfig 原子写回并规范化字段', () => {
  const configPath = tempConfigPath()
  const first = readConfig(configPath)
  const raw = JSON.stringify({ version: 1, services: [{ id: 'x', command: 'node x.mjs', cwd: 'C:/tmp', port: 4599, unknownField: 1 }] })
  const saved = saveConfig(configPath, raw, first.revision)
  assert.notEqual(saved.revision, first.revision)
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(onDisk.services.length, 1)
  assert.equal(onDisk.services[0].port, 4599)
  assert.equal(onDisk.services[0].unknownField, undefined)
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['services.json'])
})

test('saveConfig 在 revision 过期时拒绝覆盖（CONFIG_CONFLICT）', () => {
  const configPath = tempConfigPath()
  const config = readConfig(configPath)
  const before = fs.readFileSync(configPath, 'utf8')
  const error = capture(() => saveConfig(configPath, JSON.stringify({ version: 1, services: [] }), 'stale-revision'))
  assert.equal(error.code, 'CONFIG_CONFLICT')
  assert.equal(fs.readFileSync(configPath, 'utf8'), before)
})

test('saveConfig 拒绝写入无效配置（CONFIG_INVALID）', () => {
  const configPath = tempConfigPath()
  const config = readConfig(configPath)
  const error = capture(() => saveConfig(configPath, '{not json', config.revision))
  assert.equal(error.code, 'CONFIG_INVALID')
  const invalidEntry = capture(() => saveConfig(configPath, JSON.stringify({ version: 1, services: [{ id: 'a', command: '', cwd: 'C:/tmp' }] }), config.revision))
  assert.equal(invalidEntry.code, 'CONFIG_INVALID')
})
