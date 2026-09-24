/**
 * 平台探测：端口监听者、进程命令行、命令行签名校验、终止进程树。
 *
 * 这里只做一次性查询，不持有任何业务状态（状态归 supervisor）。
 * 活性判定以「端口是否在 LISTENING」为唯一真相（设计不变量 3）：
 * 不依赖我们是否见过该进程的启动过程——mechanics / tiny-world 都是别人启动的。
 */
import { execFileSync } from 'node:child_process'
import net from 'node:net'

/** 命令行查询缓存：同一轮 snapshot 里多个服务共用一次 PowerShell 调用。 */
const commandLineCache = new Map()
const CMDLINE_TTL_MS = 10_000

/**
 * 解析 `netstat -ano -p TCP` 输出中的 LISTENING 行（纯函数，便于单测）。
 * 样例：`  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    62216`
 * @param {string} output
 * @returns {Map<number, number>} 端口 → 占用者 PID（同端口多条时取第一条）
 */
export function parseListenerLines(output) {
  const listeners = new Map()
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const local = parts[1]
    const pid = Number(parts[parts.length - 1])
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0) continue
    if (!listeners.has(port)) listeners.set(port, pid)
  }
  return listeners
}

/**
 * `netstat -ano -p TCP` 的 LISTENING 行 → `Map<port, pid>`。
 * @returns {Map<number, number>} 端口 → 占用者 PID
 */
export function listListeners() {
  let output = ''
  try {
    output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
  } catch {
    return new Map()
  }
  return parseListenerLines(output)
}

/**
 * 批量读取进程命令行（一次 PowerShell 调用），带 TTL 缓存。
 * @param {number[]} pids
 * @returns {Map<number, string>}
 */
export function commandLines(pids) {
  const now = Date.now()
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]
  const result = new Map()
  const missing = []
  for (const pid of wanted) {
    const cached = commandLineCache.get(pid)
    if (cached !== undefined && now - cached.at < CMDLINE_TTL_MS) result.set(pid, cached.value)
    else missing.push(pid)
  }
  if (missing.length === 0) return result
  const filter = missing.map((pid) => `ProcessId=${pid}`).join(' or ')
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
  let parsed = null
  try {
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 12_000,
    })
    parsed = JSON.parse(output.trim() || 'null')
  } catch {
    parsed = null
  }
  const rows = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed]
  for (const row of rows) {
    const pid = Number(row?.ProcessId)
    const value = typeof row?.CommandLine === 'string' ? row.CommandLine : ''
    if (!Number.isInteger(pid)) continue
    commandLineCache.set(pid, { value, at: now })
    result.set(pid, value)
  }
  // 查不到的 PID 记为空串，避免每轮都重复调用 PowerShell。
  for (const pid of missing) {
    if (!result.has(pid)) {
      commandLineCache.set(pid, { value: '', at: now })
      result.set(pid, '')
    }
  }
  if (commandLineCache.size > 256) {
    for (const [pid, entry] of commandLineCache) if (now - entry.at > CMDLINE_TTL_MS) commandLineCache.delete(pid)
  }
  return result
}

/**
 * 命令行签名是否匹配服务定义。
 * 空模式或非法正则一律视为**不匹配**：宁可拒绝，也不静默杀掉一个身份不明的进程。
 * @param {string} commandLine
 * @param {string|undefined} pattern - RegExp 源串，大小写不敏感
 * @returns {boolean}
 */
export function matchesSignature(commandLine, pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') return false
  if (typeof commandLine !== 'string' || commandLine === '') return false
  try {
    return new RegExp(pattern, 'i').test(commandLine)
  } catch {
    return false
  }
}

/** 进程是否仍存在（信号 0 只做存在性探测，不真的发信号）。 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 终止整棵进程树（Windows：taskkill /T）。返回是否执行成功。 */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/** TCP 连接探测：端口是否真的接受连接（比「PID 存活」更贴近用户语义）。 */
export function tcpProbe(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 可选的 HTTP 健康探测：服务定义里配了 `probe.path` 才会调用。
 * @returns {Promise<{healthy: boolean|null, status: number|null}>} 连不上时 healthy=null（未知，不是不健康）
 */
export async function httpProbe(host, port, pathName = '/', expectStatus, timeoutMs = 2000) {
  const { request } = await import('node:http')
  return new Promise((resolve) => {
    const req = request({ host, port, path: pathName, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      const status = res.statusCode ?? null
      const healthy = Number.isInteger(expectStatus)
        ? status === expectStatus
        : status !== null && status < 500
      resolve({ healthy, status })
    })
    req.on('timeout', () => { req.destroy(); resolve({ healthy: null, status: null }) })
    req.on('error', () => resolve({ healthy: null, status: null }))
    req.end()
  })
}

/** 等待端口释放（stop 之后的真实判据）。 */
export async function waitForPortFree(port, { timeoutMs = 6000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!listListeners().has(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((done) => setTimeout(done, intervalMs))
  }
}

/** 等待端口开始监听（start 之后的真实判据）。 */
export async function waitForPortListening(port, { timeoutMs = 8000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (listListeners().has(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((done) => setTimeout(done, intervalMs))
  }
}
