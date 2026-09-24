/**
 * 命令行分词与平台启动形式。
 *
 * 为什么不是「把整条命令当一个 argv 元素交给 cmd.exe」：Node 在 Windows 上会把
 * 含空格/引号的单个参数整体加引号并反斜杠转义内部引号，而 cmd.exe 不认 `\"`，
 * 结果是 node 收到带引号的路径（实测：`Cannot find module '…\\"…\\scratch-server.mjs"'`）。
 * 正确形态与 DSH 自己的 runner 一致：`cmd.exe /d /s /c <程序> <参数…>`，参数各自独立。
 */

/** Windows 上无法在「分词后直传」的形式里表达的 shell 连接符。 */
const SHELL_OPERATOR = /[|&;<>^]|\|\||&&/

/**
 * 引用感知的分词：双引号成对出现，引号内保留空白，反斜杠按字面处理（Windows 路径）。
 * @param {string} command
 * @returns {string[]}
 * @throws {Error & {code:string}} 空命令或引号不配对
 */
export function splitCommand(command) {
  const text = typeof command === 'string' ? command.trim() : ''
  if (text === '') {
    const error = new Error('启动命令为空')
    error.code = 'CONFIG_INVALID'
    throw error
  }
  const words = []
  let current = ''
  let quoted = false
  let hasContent = false
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted
      hasContent = true
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (hasContent) {
        words.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    current += char
    hasContent = true
  }
  if (quoted) {
    const error = new Error(`启动命令的引号不配对：${text}`)
    error.code = 'CONFIG_INVALID'
    throw error
  }
  if (hasContent) words.push(current)
  return words
}

/**
 * 生成平台启动 argv。
 * - Windows：`cmd.exe /d /s /c` + 分词后的各个参数（这样才能解析 npm 这类 .cmd，同时不被引号转义破坏）；
 *   含管道/重定向/与或连接符的命令显式拒绝，而不是悄悄按字面量执行。
 * - 其它平台：`/bin/sh -lc <整条命令>`（POSIX shell 自己会正确解析引号）。
 * @param {string} command
 * @param {string} [platform]
 * @returns {string[]}
 */
export function launchArgv(command, platform = process.platform) {
  if (platform !== 'win32') return ['/bin/sh', '-lc', command]
  if (SHELL_OPERATOR.test(command)) {
    const error = new Error(`启动命令不支持管道/重定向/连接符：${command}`)
    error.code = 'CONFIG_INVALID'
    throw error
  }
  return ['cmd.exe', '/d', '/s', '/c', ...splitCommand(command)]
}
