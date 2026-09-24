/**
 * command.mjs 单测：分词正确性与平台启动形式。
 * 这里覆盖的是实测踩过的坑：整条命令当作单个 argv 元素会被 Node 转义内部引号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchArgv, splitCommand } from '../src/command.mjs'

test('splitCommand 保留引号内的空白', () => {
  assert.deepEqual(splitCommand('node "C:\\Program Files\\x\\srv.mjs" 4599'), ['node', 'C:\\Program Files\\x\\srv.mjs', '4599'])
  assert.deepEqual(splitCommand('npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'),
    ['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'])
  assert.deepEqual(splitCommand('  node   a.mjs  '), ['node', 'a.mjs'])
})

test('splitCommand 拒绝空命令与不配对引号', () => {
  assert.equal(capture(() => splitCommand('   ')).code, 'CONFIG_INVALID')
  assert.equal(capture(() => splitCommand('node "unclosed.mjs')).code, 'CONFIG_INVALID')
})

test('launchArgv 在 Windows 上把参数分开放进 cmd.exe', () => {
  assert.deepEqual(launchArgv('node "C:\\Program Files\\x\\srv.mjs" 4599', 'win32'),
    ['cmd.exe', '/d', '/s', '/c', 'node', 'C:\\Program Files\\x\\srv.mjs', '4599'])
})

test('launchArgv 在 Windows 上显式拒绝 shell 连接符', () => {
  assert.equal(capture(() => launchArgv('node a.mjs | more', 'win32')).code, 'CONFIG_INVALID')
  assert.equal(capture(() => launchArgv('node a.mjs && node b.mjs', 'win32')).code, 'CONFIG_INVALID')
  assert.equal(capture(() => launchArgv('node a.mjs > out.log', 'win32')).code, 'CONFIG_INVALID')
})

test('launchArgv 在 POSIX 上交给 sh 解析整条命令', () => {
  assert.deepEqual(launchArgv('node a.mjs && echo done', 'linux'), ['/bin/sh', '-lc', 'node a.mjs && echo done'])
})

function capture(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('期望抛出错误，但没有')
}
