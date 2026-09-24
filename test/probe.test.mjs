/**
 * probe.mjs 的纯函数单测：netstat 解析与命令行签名匹配。
 * 签名匹配是「谁能被终止」的唯一闸门，必须正反都覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesSignature, parseListenerLines } from '../src/probe.mjs'

const NETSTAT_SAMPLE = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1828
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       62216
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       58544
  TCP    127.0.0.1:3080         127.0.0.1:52000        ESTABLISHED     62216
  TCP    [::]:445               [::]:0                 LISTENING       4
   UDP    0.0.0.0:500             *:*                                    1234
`

test('parseListenerLines 只接受 LISTENING 行', () => {
  const listeners = parseListenerLines(NETSTAT_SAMPLE)
  assert.equal(listeners.get(3080), 62216)
  assert.equal(listeners.get(5173), 58544)
  assert.equal(listeners.get(135), 1828)
  // IPv6 形式也要能取出端口
  assert.equal(listeners.get(445), 4)
  // ESTABLISHED 与 UDP 行不参与
  assert.equal(listeners.size, 4)
})

test('parseListenerLines 对空输入与垃圾行安全', () => {
  assert.equal(parseListenerLines('').size, 0)
  assert.equal(parseListenerLines(undefined).size, 0)
  assert.equal(parseListenerLines('  TCP  127.0.0.1:80  LISTENING  notanumber').size, 0)
})

test('matchesSignature 命中真实命令行（大小写不敏感）', () => {
  const commandLine = '"D:\\Program Files\\nodejs\\node.exe" C:\\Users\\chany\\AppData\\Roaming\\npm\\node_modules\\@veewo\\mechanics\\src\\server\\cli.mjs web --port 4319'
  assert.equal(matchesSignature(commandLine, '@veewo[\\\\/]mechanics[\\\\/]src[\\\\/]server[\\\\/]cli\\.mjs"?\\s+web'), true)
  assert.equal(matchesSignature(commandLine, 'MECHANICS'), true)
})

test('matchesSignature 拒绝不匹配、空模式与非法正则', () => {
  const commandLine = '"node.exe" G:\\Projects\\tiny-world\\Web Prototype\\node_modules\\.bin\\..\\vite\\bin\\vite.js --port 5173'
  assert.equal(matchesSignature(commandLine, 'mechanics'), false)
  assert.equal(matchesSignature(commandLine, ''), false)
  assert.equal(matchesSignature(commandLine, undefined), false)
  assert.equal(matchesSignature(commandLine, '([unclosed'), false)
  assert.equal(matchesSignature('', 'vite'), false)
  assert.equal(matchesSignature(undefined, 'vite'), false)
})
