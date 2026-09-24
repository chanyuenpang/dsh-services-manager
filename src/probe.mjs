/**
 * 平台探测：端口监听者、进程命令行、命令行签名校验、终止进程树。
 *
 * 设计约束（v2）：
 * - **全部异步**：旧实现用 `execFileSync` 跑 netstat/PowerShell，会把宿主事件循环整个卡住
 *   （实测一次 snapshot 期间 10ms 定时器 0 次触发）。这里一律 `execFile` + Promise。
 * - **命令行按 PID 永久缓存**：同一 PID 的命令行不会变；旧实现 10s TTL 让 4s 轮询反复付出
 *   PowerShell 冷启动成本（实测约 1.8s）。
 * - 并发请求会**合并成一次** PowerShell 调用（micro-batch），避免同一时刻重复起进程。
 * - 活性判定的快层用 `tcpProbe`（毫秒级），PID/命令行属于详层，见 supervisor 的两层快照。
 */
import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 命令行缓存：pid → 命令行（'' 表示该 PID 查不到，通常是已退出）。 */
const commandLineCache = new Map()
/** 微批处理状态：把同一 tick 内的多批 PID 合成一次 PowerShell 调用。 */
let batchPids = new Set()
let batchPromise = null
const COMMAND_LINE_CACHE_LIMIT = 1024

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
 * `netstat -ano -p TCP` 的 LISTENING 行 → `Map<port, pid>`（异步，不阻塞事件循环）。
 * @returns {Promise<Map<number, number>>} 端口 → 占用者 PID
 */
export async function listListeners({ timeoutMs = 8000 } = {}) {
  try {
    const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    })
    return parseListenerLines(stdout)
  } catch {
    return new Map()
  }
}

/** 执行一次批量命令行查询；同一批 PID 合并在一次 PowerShell 调用里。 */
async function fetchCommandLines(pids) {
  const fetched = new Map()
  if (pids.length === 0) return fetched
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' or ')
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout.trim() || 'null')
    const rows = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed]
    for (const row of rows) {
      const pid = Number(row?.ProcessId)
      if (!Number.isInteger(pid)) continue
      fetched.set(pid, typeof row?.CommandLine === 'string' ? row.CommandLine : '')
    }
  } catch {
    // 整批失败时不缓存任何结果：调用方会在重试里再试一次，最后以 '' 兜底。
  }
  return fetched
}

/** 把 PID 加入当前 micro-batch，并等待该批次的结果（本 tick 内的请求共享一次调用）。 */
function scheduleCommandLines(pids) {
  for (const pid of pids) batchPids.add(pid)
  if (batchPromise === null) {
    batchPromise = new Promise((resolve) => { setTimeout(resolve, 0) }).then(async () => {
      const batch = [...batchPids]
      batchPids = new Set()
      batchPromise = null
      const fetched = await fetchCommandLines(batch)
      for (const [pid, value] of fetched) {
        if (commandLineCache.size >= COMMAND_LINE_CACHE_LIMIT) {
          const oldest = commandLineCache.keys().next().value
          commandLineCache.delete(oldest)
        }
        commandLineCache.set(pid, value)
      }
      return fetched
    })
  }
  return batchPromise
}

/**
 * 批量读取进程命令行（异步、按 PID 永久缓存、并发合并）。
 * @param {number[]} pids
 * @returns {Promise<Map<number, string>>} 查不到的 PID 映射为 ''（通常是进程已退出）
 */
export async function commandLines(pids) {
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]
  const result = new Map()
  let pending = []
  for (const pid of wanted) {
    if (commandLineCache.has(pid)) result.set(pid, commandLineCache.get(pid))
    else pending.push(pid)
  }
  // 最多两轮：第一轮可能只赶上别人的批次，第二轮为本批新起的调用补齐。
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
    const fetched = await scheduleCommandLines(pending)
    pending = pending.filter((pid) => {
      if (fetched.has(pid) || commandLineCache.has(pid)) {
        result.set(pid, fetched.get(pid) ?? commandLineCache.get(pid) ?? '')
        return false
      }
      return true
    })
  }
  for (const pid of pending) result.set(pid, '')
  return result
}

/** 仅供测试/诊断：当前命令行缓存条数。 */
export function commandLineCacheSize() {
  return commandLineCache.size
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

/** 终止整棵进程树（Windows：taskkill /T）。异步，不阻塞事件循环。 */
export async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

/** TCP 连接探测：端口是否真的接受连接（比「PID 存活」更贴近用户语义，且毫秒级）。 */
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
    if (!(await listListeners()).has(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((done) => setTimeout(done, intervalMs))
  }
}

/** 等待端口开始监听（start 之后的真实判据）。 */
export async function waitForPortListening(port, { timeoutMs = 8000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await listListeners()).has(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((done) => setTimeout(done, intervalMs))
  }
}
