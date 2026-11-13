/**
 * 服务监管核心：观测快照 + 控制操作。
 *
 * 设计约束（与 feature-architecture 报告一致）：
 * - 活性真相 = 端口 LISTENING（probe.listListeners），不是「PID 存活」；
 * - 所有权两类：`spawned`（本插件持 handle）/ `discovered`（按端口发现的外部占用者），永不混淆；
 * - 只有命令行签名匹配的端口占用者才会被终止，否则抛 PORT_OWNED_BY_OTHER；
 * - 所有控制操作按服务串行化（不变量 8）；
 * - 运行态不持久化（不变量 1/6）。
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { launchArgv } from './command.mjs'
import * as probe from './probe.mjs'
import { readConfig, saveConfig, setAutostart, parseConfig } from './config.mjs'
import { mergeRegistration } from './registration.mjs'

/** dsh 自身的保留 id。 */
export const SELF_ID = 'dsh'
/** Desktop Host 运行在 Electron 的 Node-mode 子进程；Web Host 则由 lib/bin.js web 启动。 */
export function detectDshRuntime(argv = process.argv) {
  return Array.isArray(argv) && argv.some((value) => /@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]index\.js/i.test(String(value)))
    ? 'desktop'
    : 'web'
}
const START_WAIT_MS = 8000
const STOP_WAIT_MS = 8000
/** spawn 出来的服务进程 stdout/stderr 的内存保留窗口与完整落盘上限。 */
const COLLECT_MAX_BYTES = 65536
const SPILL_MAX_BYTES = 16 * 1024 * 1024
const GRACE_MS = 10_000

/** 面板确认后显式 3 秒；其它 RPC 调用未指定时仍保留 60 秒。 */
export function normalizeRestartGraceSeconds(value) {
  const requested = Number(value ?? 60)
  return Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 3), 3600) : 60
}

const run = promisify(execFile)

// 快照探测允许降级，但控制动作不能把 netstat 失败当作「端口空闲」。
// 复用平台解析器；不改 probe 的宽容观测接口与缓存/统计契约。
async function controlListeners() {
  const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024,
  })
  return probe.parseListenerLines(stdout)
}

function fail(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

/**
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx - 宿主上下文（提供 ctx.subprocess）
 * @param {string} input.configPath - 配置文件绝对路径
 * @param {string} input.stateDir - 插件状态目录
 * @param {string} input.logDir - 日志目录
 * @param {string} input.supervisorScript - dsh 自重启看守脚本路径
 */
export function createManager({ ctx, configPath, stateDir, logDir, supervisorScript, io = {} }) {
  // 默认是真实平台 I/O；测试可精确控制异步边界，不启动或终止宿主进程。
  const { commandLines, killTree, listListeners, matchesSignature, tcpProbe } = { ...probe, ...io }
  const controlList = io.listListeners ?? controlListeners
  const waitForPortFree = io.waitForPortFree ?? ((port, options) => waitForControlPort(port, false, options))
  const waitForPortListening = io.waitForPortListening ?? ((port, options) => waitForControlPort(port, true, options))
  /** @type {Map<string, {handle:any, pending:string|null, startedAt:number|null, lastExit:{code:number|null,at:string}|null, lastError:string|null, lastOperation:string|null, updatedAt:string}>} */
  const instances = new Map()
  /** 每服务一条串行链：重复点击不会产生并发操作。 */
  const chains = new Map()
  let revision = 0
  const runtimeKind = detectDshRuntime()
  let selfPort = null
  let scheduledRestart = null
  /**
   * 详层结果（netstat 的「端口 → pid/命令行」）。快层绝不自己跑 netstat，
   * 只读这里；缺失就如实显示「读取中」，不猜测。
   */
  let detail = null
  let detailInFlight = null
  /** 已组装快照的缓存（进程内，不持久化）：快层命中它就 0ms 返回。 */
  let snapshotCache = null
  /** 不变量 8：dispose 之后不得再回写缓存、推进 revision 或继续在途补齐。 */
  let disposed = false
  /** 快层 TCP 探测的超时：够本机 loopback 用，且决定首屏最坏耗时。 */
  const FAST_PROBE_TIMEOUT_MS = 250
  /** 快照缓存的有效期（设计建议值）：期间内的 fast 请求直接命中，不再做 TCP 探测。 */
  const TIER1_TTL_MS = 1500
  /** 详层多久算「该重新采了」：到点后台刷新，不影响本次返回。 */
  const DETAIL_TTL_MS = 30_000
  /** 详层超过这个年龄就在响应里标 degraded，让客户端知道「当前看到的是旧详情」。 */
  const DETAIL_STALE_MS = 5000
  /** 快照模式：'full' 等详层刷新（旧调用/显式刷新），'fast' 立即用缓存或快层返回。 */
  const SNAPSHOT_MODES = new Set(['fast', 'full'])

  const now = () => new Date().toISOString()

  function touch() {
    if (disposed) return revision
    snapshotCache = null
    revision += 1
    return revision
  }

  function enqueue(id, work) {
    const previous = chains.get(id) ?? Promise.resolve()
    const next = previous.then(work, work)
    chains.set(id, next.then(() => undefined, () => undefined))
    return next
  }

  function instanceOf(id) {
    let instance = instances.get(id)
    if (instance === undefined) {
      instance = {
        handle: null, handleAlive: false, pending: null, startedAt: null,
        lastExit: null, lastError: null, lastStopAt: null, lastOperation: null, updatedAt: now(),
      }
      instances.set(id, instance)
    }
    return instance
  }

  /** 本实例监听端口：优先 netstat 确认结果，其次 --port；Desktop 固定 19387，CLI Web 缺省 3080。 */
  function argvSelfPort() {
    const index = process.argv.findIndex((arg) => arg === '--port')
    const explicit = index === -1 ? Number.NaN : Number(process.argv[index + 1])
    return Number.isInteger(explicit) ? explicit : runtimeKind === 'desktop' ? 19387 : 3080
  }

  /** 详层专用：从 netstat 结果里确认「本进程」的监听端口并缓存。 */
  function detectSelfPort(listeners) {
    if (selfPort !== null) return selfPort
    for (const [port, pid] of listeners) {
      if (pid === process.pid) {
        selfPort = port
        return port
      }
    }
    selfPort = argvSelfPort()
    return selfPort
  }

  /** 快层可用的自身端口：已确认值 → argv → 3080。 */
  function currentSelfPort() {
    return selfPort ?? argvSelfPort()
  }

  /**
   * 详层刷新：一次 netstat + 一次（按 PID 永久缓存的）命令行查询。
   * 并发调用共享同一个 in-flight promise；失败时保留旧结果（快照会标 stale）。
   */
  function refreshDetail() {
    if (detailInFlight !== null) return detailInFlight
    detailInFlight = (async () => {
      try {
        const listeners = await listListeners()
        const confirmed = detectSelfPort(listeners)
        const { list } = definitions()
        const wantedPorts = [confirmed, ...list.map((definition) => definition.port).filter((port) => port !== null)]
        const byPort = new Map()
        for (const port of new Set(wantedPorts)) {
          const pid = listeners.get(port)
          if (pid !== undefined) byPort.set(port, { pid, commandLine: '' })
        }
        const commandLineMap = await commandLines([...new Set([...byPort.values()].map((entry) => entry.pid))])
        for (const entry of byPort.values()) entry.commandLine = commandLineMap.get(entry.pid) ?? ''
        if (disposed === true) return detail
        detail = { at: Date.now(), selfPort: confirmed, byPort }
        touch()
      } catch {
        // 保住旧详层：宁可显示带 stale 标记的旧 pid，也不清空成「未知」。
      } finally {
        detailInFlight = null
      }
      return detail
    })()
    return detailInFlight
  }

  function selfDefinition(port) {
    return {
      id: SELF_ID,
      title: runtimeKind === 'desktop' ? 'DSH Desktop（本应用）' : 'DSH Web（本实例）',
      runtimeKind,
      canRestartHost: process.platform === 'win32',
      port,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${port}/`,
      command: [process.execPath, ...process.argv.slice(1)].join(' '),
      cwd: process.cwd(),
      env: {},
      autostart: false,
      autoStopOnExit: false,
      probe: { path: null, expectStatus: null, intervalMs: null },
      match: { commandLinePattern: '@deepseek-ai[\\\\/]dsh[\\\\/]lib[\\\\/]bin\\.js' },
      restartMode: 'supervisor',
      takeover: 'match',
      managed: false,
      self: true,
    }
  }

  function definitions() {
    const config = readConfig(configPath)
    return { config, list: config.services.map((definition) => ({ ...definition, managed: true, self: false })) }
  }

  function findDefinition(id) {
    const { list } = definitions()
    const found = list.find((definition) => definition.id === id)
    if (found !== undefined) return found
    if (id === SELF_ID) return selfDefinition(currentSelfPort())
    throw fail('SERVICE_NOT_FOUND', `没有 id 为 ${id} 的服务定义`, { id, configPath })
  }

  /** 观测一条服务的运行态（不修改任何状态）。 */
  /**
   * 观测一条服务的运行态（不修改任何状态）。
   * @param definition - 服务定义
   * @param fast - 快层结果 `{ running }`（本机 TCP 探测，毫秒级）
   * @param detailLayer - 详层结果 `{ at, byPort }`，可能为 null（首次）或偏旧
   */
  function stateOf(definition, fast, detailLayer) {
    const instance = instances.get(definition.id)
    // handle 的存活由 done 的结算维护；subprocess handle 不暴露子进程 PID，
    // 所以「谁在跑」一律由端口回答，「是不是我启动的」由 handle 是否仍在托管回答。
    const handleAlive = instance?.handle != null && instance?.handleAlive === true
    const detailEntry = definition.port === null ? null : detailLayer?.byPort?.get(definition.port) ?? null
    let status = 'stopped'
    let ownership = 'none'
    let pid = null
    if (instance?.pending === 'starting' || instance?.pending === 'stopping') {
      status = instance.pending
      ownership = instance.pending === 'stopping' ? 'none' : 'spawned'
      pid = detailEntry?.pid ?? null
    } else if (fast.running === true) {
      status = 'running'
      // 端口在应答 = 在跑；有 handle → 是我们启动的，否则是外部进程。
      ownership = handleAlive ? 'spawned' : 'discovered'
      pid = detailEntry?.pid ?? null
    } else if (instance?.handle != null && handleAlive) {
      status = instance.startedAt !== null && Date.now() - instance.startedAt > START_WAIT_MS ? 'unknown' : 'starting'
      ownership = 'spawned'
    } else if (instance?.lastError !== null && instance?.lastError !== undefined) {
      status = 'error'
    } else if (instance?.lastExit !== null && instance?.lastExit !== undefined && instance.lastExit.code !== 0
      && instance?.lastStopAt === null) {
      // 只有「不是我们主动停止」造成的非零退出才算异常。
      status = 'error'
    }
    return {
      id: definition.id,
      title: definition.title,
      port: definition.port,
      host: definition.host,
      url: definition.url,
      autostart: definition.autostart,
      autoStopOnExit: definition.autoStopOnExit,
      restartMode: definition.restartMode,
      takeover: definition.takeover,
      status,
      ownership: definition.self === true ? 'none' : ownership,
      pid: definition.self === true ? process.pid : pid,
      healthy: null,
      commandLine: definition.self === true ? null : detailEntry?.commandLine ?? null,
      lastExit: instance?.lastExit ?? null,
      lastError: instance?.lastError ?? null,
      lastOperation: instance?.lastOperation ?? null,
      updatedAt: instance?.updatedAt ?? now(),
      managed: definition.managed !== false,
      runtimeKind: definition.self === true ? runtimeKind : null,
      canRestartHost: definition.self === true ? process.platform === 'win32' : false,
    }
  }

  /**
   * 组装快照（读路径）。
   *
   * 两层：
   * - **快层**：对每条有端口的服务做本机 TCP 探测（并行、250ms 超时），得到 status/ownership。
   *   首屏只需要它。
   * - **详层**：netstat + 按 PID（永久缓存）取命令行，补齐 pid/commandLine；慢且可能失败，
   *   所以它异步补齐，缺失时如实标 `stale`/`refreshing`，绝不阻塞快层。
   *
   * @param {{mode?: 'fast'|'full'}} [options] - `full` 等详层刷新完成（旧调用/显式刷新用），
   *   `fast`（缺省）立即用现有详层返回并在后台刷新。
   */
  /**
   * 给快照挂上新鲜度元数据（唯一 owner 是宿主；客户端只投影，不自己造）。
   * @param payload - 已组装好的快照主体
   * @param collectedAt - 这份 services 是何时采到的
   * @param extra - `{ returnedFromCache, cacheMiss }`
   */
  function withTiming(payload, collectedAt, extra) {
    const at = Date.now()
    return {
      ...payload,
      timing: {
        collectedAt,
        servedAt: extra.servedAt ?? at,
        ageMs: at - collectedAt,
        tier: detail === null ? 1 : 2,
        returnedFromCache: extra.returnedFromCache === true,
        refreshing: detailInFlight !== null,
        degraded: detail === null || at - detail.at > DETAIL_STALE_MS,
        revision,
        cacheMiss: extra.cacheMiss === true,
      },
    }
  }

  async function snapshot(options = {}) {
    const mode = SNAPSHOT_MODES.has(options.mode) ? options.mode : 'full'
    const startedAt = Date.now()
    // 快层命中：上一份观测还在 tier1 TTL 内 → 0ms 直接返回它，慢层继续在后台补齐。
    if (mode === 'fast' && snapshotCache !== null && startedAt - snapshotCache.collectedAt <= TIER1_TTL_MS) {
      if (detail === null || startedAt - detail.at > DETAIL_TTL_MS) void refreshDetail()
      return withTiming(snapshotCache.payload, snapshotCache.collectedAt, {
        returnedFromCache: true, cacheMiss: false, servedAt: startedAt,
      })
    }
    const cacheMiss = snapshotCache === null
    const { config, list } = definitions()
    if (mode === 'full') {
      await refreshDetail()
    } else if (detail === null || startedAt - detail.at > DETAIL_TTL_MS) {
      void refreshDetail()
    }
    const definitionsAll = [selfDefinition(currentSelfPort()), ...list]
    const probes = await Promise.all(definitionsAll.map((definition) => (
      definition.port === null ? Promise.resolve(false) : tcpProbe(definition.host, definition.port, FAST_PROBE_TIMEOUT_MS)
    )))
    const services = definitionsAll.map((definition, index) => stateOf(definition, { running: probes[index] }, detail))
    // 可选 HTTP 健康探测：只在定义里显式配了 probe.path 时进行（属 tier2）。
    await Promise.all(services.map(async (service, index) => {
      const probe = definitionsAll[index].probe
      if (probe?.path == null || service.port === null || service.status !== 'running') return
      const { httpProbe } = await import('./probe.mjs')
      const result = await httpProbe(service.host, service.port, probe.path, probe.expectStatus)
      service.healthy = result.healthy
    }))
    const summary = { total: services.length, running: 0, stopped: 0, error: 0, unknown: 0 }
    for (const service of services) {
      if (service.status === 'running') summary.running += 1
      else if (service.status === 'error') summary.error += 1
      else if (service.status === 'stopped') summary.stopped += 1
      else summary.unknown += 1
    }
    const payload = {
      revision,
      configPath,
      configRevision: config.revision,
      stateDir,
      configIssues: config.issues,
      summary,
      services,
      mode,
    }
    if (disposed === false) snapshotCache = { collectedAt: Date.now(), revision, payload }
    return withTiming(payload, snapshotCache?.collectedAt ?? startedAt, {
      returnedFromCache: false, cacheMiss, servedAt: startedAt,
    })
  }

  function assertActive() {
    if (disposed) throw fail('MANAGER_DISPOSED', '服务管理器已卸载，操作已取消。')
  }

  function managedDefinition(id) {
    assertActive()
    const definition = findDefinition(id)
    if (definition.self) throw fail('OPERATION_FAILED', '内置 dsh 不能使用普通启停/重启；请使用「重启 DSH」。')
    return definition
  }

  // 恢复可能排在手动 stop 后，也可能在异步探测期间遇到编辑/删除。
  function restoreAllowed(id) {
    assertActive()
    return definitions().list.some((entry) => entry.id === id && entry.autostart === true)
  }

  async function waitForControlPort(port, present, { timeoutMs }) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      assertActive()
      const listeners = await controlList()
      assertActive()
      if (listeners.has(port) === present) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async function listenerIdentity(definition) {
    const pid = (await controlList()).get(definition.port)
    assertActive()
    if (pid === undefined) return null
    if (pid === process.pid) throw fail('OPERATION_FAILED', '普通服务操作不能控制 DSH 宿主进程。', { port: definition.port, pid })
    const commandLine = (await commandLines([pid], { fresh: true })).get(pid) ?? ''
    assertActive()
    if (!matchesSignature(commandLine, definition.match?.commandLinePattern)) {
      throw fail('PORT_OWNED_BY_OTHER', '端口 ' + definition.port + ' 的监听者身份不匹配，已拒绝控制。',
        { port: definition.port, pid, commandLine, pattern: definition.match?.commandLinePattern ?? '' })
    }
    // 命令行查询期间监听者可能换代，不能把旧 PID 的签名用于新监听者。
    if ((await controlList()).get(definition.port) !== pid) {
      throw fail('PORT_OWNED_BY_OTHER', '端口监听者在身份校验期间发生变化，请刷新后重试。', { port: definition.port, pid })
    }
    assertActive()
    return pid
  }

  /** 内部执行不入队、不改策略；调用者持有该服务的完整事务队列。 */
  async function startInternal(definition, { restoring = false } = {}) {
    const id = definition.id
    const allowed = () => { assertActive(); return !restoring || restoreAllowed(id) }
    if (!allowed()) return 'skipped'
    const instance = instanceOf(id)
    instance.pending = 'starting'
    instance.lastError = null
    instance.lastOperation = 'start'
    touch()
    try {
      const existingPid = definition.port === null ? null : await listenerIdentity(definition)
      if (!allowed()) return 'skipped'
      // 配置在探测期间被编辑时重新判断，旧监听者也不能代表新定义已就绪。
      if (restoring) {
        const latest = managedDefinition(id)
        if (JSON.stringify(latest) !== JSON.stringify(definition)) return await startInternal(latest, { restoring })
      }
      if (existingPid !== null) return 'already-running'
      if (instance.handle == null || instance.handleAlive === false) {
        assertActive() // 最后一道同步门禁：此处到 spawn 之间没有 await。
        const handle = ctx.subprocess.spawn({
          argv: launchArgv(definition.command), cwd: definition.cwd, env: { ...definition.env },
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: COLLECT_MAX_BYTES, spill: { maxBytes: SPILL_MAX_BYTES } },
            stderr: { maxBytes: COLLECT_MAX_BYTES, spill: { maxBytes: SPILL_MAX_BYTES } },
          },
          graceMs: GRACE_MS,
        })
        instance.handle = handle
        instance.handleAlive = true
        instance.startedAt = Date.now()
        instance.lastStopAt = null
        instance.lastExit = null
        instance.autoStopOnExit = definition.autoStopOnExit
        handle.done.then((outcome) => {
          if (disposed || instance.handle !== handle) return
          instance.handleAlive = false
          instance.lastExit = { code: outcome.exitCode, at: now() }
          if (outcome.exitCode !== 0 && outcome.exitCode !== null && instance.lastStopAt === null) {
            instance.lastError = '进程退出，退出码 ' + outcome.exitCode
          }
          instance.updatedAt = now()
          touch()
        }).catch((error) => {
          if (disposed || instance.handle !== handle) return
          instance.handleAlive = false
          instance.lastError = '子进程失败：' + String(error?.message ?? error)
          instance.updatedAt = now()
          touch()
        })
      }
      if (definition.port === null) return 'dispatched' // 没有网络就绪证据，不声称已运行。
      const listening = await waitForPortListening(definition.port, { timeoutMs: START_WAIT_MS })
      assertActive()
      if (!instance.handleAlive) throw fail('OPERATION_FAILED', instance.lastError ?? '启动的进程已退出，未确认服务就绪。')
      if (!listening) throw fail('TIMEOUT', '启动后 ' + START_WAIT_MS + 'ms 内端口 ' + definition.port + ' 未进入监听')
      const pid = await listenerIdentity(definition)
      assertActive()
      if (!instance.handleAlive) throw fail('OPERATION_FAILED', '启动的进程在就绪确认期间退出。')
      if (pid === null) throw fail('TIMEOUT', '就绪确认期间端口已停止监听。')
      return 'started'
    } catch (error) {
      if (!disposed) instance.lastError = String(error?.message ?? error)
      throw error
    } finally {
      if (!disposed) {
        instance.pending = null
        instance.updatedAt = now()
        touch()
      }
    }
  }

  async function stopInternal(definition) {
    assertActive()
    const instance = instanceOf(definition.id)
    instance.pending = 'stopping'
    instance.lastOperation = 'stop'
    instance.lastStopAt = now()
    touch()
    try {
      let handleExitError = null
      if (instance.handle != null && instance.handleAlive) {
        instance.handle.terminate()
        try {
          const exited = await instance.handle.waitForExit(AbortSignal.timeout(STOP_WAIT_MS))
          if (exited === false) throw fail('TIMEOUT', '未能确认托管进程已退出。')
          instance.handleAlive = false
        } catch (error) {
          handleExitError = error
        }
        assertActive()
      }
      if (definition.port !== null) {
        const pid = await listenerIdentity(definition)
        assertActive()
        if (pid !== null) {
          // options.force 与 takeover=force 均不能绕过以上实时签名校验。
          await killTree(pid)
          assertActive()
          const free = await waitForPortFree(definition.port, { timeoutMs: STOP_WAIT_MS })
          assertActive()
          if (!free) throw fail('TIMEOUT', '已发出终止命令，但端口仍未释放。', { port: definition.port, pid })
        }
      }
      if (handleExitError && instance.handleAlive) throw fail('TIMEOUT', '未能确认托管进程已退出。')
      instance.lastError = null
      return 'stopped'
    } catch (error) {
      if (!disposed) instance.lastError = String(error?.message ?? error)
      throw error
    } finally {
      if (!disposed) {
        instance.pending = null
        instance.updatedAt = now()
        touch()
      }
    }
  }

  function intentCommand(id, autostart, execute) {
    return enqueue(id, async () => {
      managedDefinition(id)
      // 同步 read → validate → patch → save，没有跨服务异步丢更新窗口。
      const saved = setAutostart(configPath, id, autostart)
      const policy = { policyCommitted: true, autostart, configRevision: saved.revision }
      touch()
      try {
        const status = await execute(saved.definition)
        const observed = await snapshot()
        assertActive()
        return { ...observed, operation: { id, status, ...policy } }
      } catch (error) {
        throw fail(error?.code ?? 'OPERATION_FAILED', String(error?.message ?? error), { ...error?.details, ...policy })
      }
    })
  }

  function start(id) { return intentCommand(id, true, startInternal) }
  function stop(id) { return intentCommand(id, false, stopInternal) }

  /** restart 是一个完整队列事务，完全不写策略，也不能跳转到 DSH 看守。 */
  function restart(id) {
    return enqueue(id, async () => {
      const definition = managedDefinition(id)
      if (definition.restartMode === 'supervisor') throw fail('OPERATION_FAILED', '普通服务不支持 supervisor 重启模式。')
      await stopInternal(definition)
      assertActive()
      const status = await startInternal(definition)
      const observed = await snapshot()
      assertActive()
      return { ...observed, operation: { id, status } }
    })
  }

  /**
   * 安排 dsh 自我重启：分离看守进程（复用 dsh-restart skill 的已验证形态）。
   * 显式请求可以是 3s；未指定仍默认 60s，绝不静默为 0。
   */
  async function scheduleDshRestart(options = {}) {
    assertActive()
    if (process.platform !== 'win32') throw fail('UNSUPPORTED_RUNTIME', 'DSH 自重启当前只支持 Windows。', { runtimeKind })
    const stamp = Date.now()
    if (scheduledRestart !== null && stamp < scheduledRestart.executeAt + 60_000) {
      throw fail('ALREADY_SCHEDULED', '已经安排过一次 dsh 重启，不会重复启动看守进程。', {
        scheduledAt: scheduledRestart.scheduledAt,
        graceMs: scheduledRestart.graceMs,
      })
    }
    const listeners = await listListeners()
    const port = detectSelfPort(listeners)
    const graceSeconds = normalizeRestartGraceSeconds(options.graceSeconds)
    const args = [
      supervisorScript,
      '--apply',
      '--grace', String(graceSeconds),
      '--port', String(port),
      '--cwd', process.cwd(),
      '--log-dir', logDir,
    ]
    if (options.keepSandboxes === true) args.push('--keep-sandboxes')
    assertActive()
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    })
    child.unref()
    scheduledRestart = {
      scheduledAt: now(),
      executeAt: stamp + graceSeconds * 1000,
      graceMs: graceSeconds * 1000,
      logPath: path.join(logDir, 'host-restart.log'),
      port,
      runtimeKind,
    }
    return {
      accepted: true,
      graceMs: scheduledRestart.graceMs,
      logPath: scheduledRestart.logPath,
      scheduledAt: scheduledRestart.scheduledAt,
      port,
      runtimeKind,
    }
  }

  /** 读取一条服务的最近输出（collect 模式的 tail + spill 路径）。 */
  async function logs(id, options = {}) {
    const instance = instances.get(id)
    if (instance?.handle == null) return { id, path: null, text: '' }
    const lines = Number.isInteger(options.lines) ? Math.min(Math.max(options.lines, 1), 2000) : 200
    const stdout = instance.handle.collected?.stdout?.readFrom(0)
    const stderr = instance.handle.collected?.stderr?.readFrom(0)
    const tail = (text) => {
      const rows = String(text ?? '').split(/\r?\n/)
      return rows.slice(Math.max(0, rows.length - lines)).join('\n')
    }
    const parts = []
    if (stdout?.text) parts.push(tail(stdout.text))
    if (stderr?.text) parts.push(`--- stderr ---\n${tail(stderr.text)}`)
    return { id, path: stdout?.spillPath ?? stderr?.spillPath ?? null, text: parts.join('\n\n') }
  }

  /** 读取配置原文（面板编辑器用）。 */
  async function configGet() {
    const config = readConfig(configPath)
    return { path: configPath, revision: config.revision, raw: config.raw }
  }

  /** 写回配置（原子 + expectedRevision）。 */
  async function configSet(payload = {}) {
    if (typeof payload.raw !== 'string') throw fail('CONFIG_INVALID', 'config.set 需要 raw 文本')
    const result = saveConfig(configPath, payload.raw, payload.expectedRevision)
    touch()
    return { path: result.path, revision: result.revision, raw: result.raw }
  }

  /** dsh 启动时拉起 autostart 项；失败只记录，不阻塞其它服务。 */
  async function autostart() {
    let list = []
    try {
      list = definitions().list
    } catch (error) {
      console.warn(`[dsh-services-manager] 读取配置失败：${String(error?.message ?? error)}`)
      return
    }
    for (const definition of list) {
      if (disposed) break
      if (definition.autostart !== true) continue
      try {
        const status = await enqueue(definition.id, async () => {
          if (!restoreAllowed(definition.id)) return 'skipped'
          return startInternal(managedDefinition(definition.id), { restoring: true })
        })
        console.log('[dsh-services-manager] autostart ' + definition.id + ': ' + status)
      } catch (error) {
        console.warn(`[dsh-services-manager] autostart 失败 ${definition.id}：${String(error?.message ?? error)}`)
      }
    }
  }

  /** 插件卸载（dsh 退出/重启）时停止本插件启动的实例。 */
  async function dispose() {
    // 不变量 8：先立旗，在途的探测/补齐回来时不得再回写缓存或推进 revision。
    disposed = true
    const { list } = (() => {
      try {
        return definitions()
      } catch {
        return { list: [] }
      }
    })()
    const current = new Map(list.map((definition) => [definition.id, definition]))
    for (const [id, instance] of instances) {
      if (instance.handle == null || !instance.handleAlive) continue
      if ((current.get(id)?.autoStopOnExit ?? instance.autoStopOnExit) === false) continue
      try {
        instance.handle.terminate()
      } catch { /* 托管范围可能已消失 */ }
    }
  }

  /** 把规范化定义还原成配置文件里的字段形状（saveConfig 会再规范化一次并原子落盘）。 */
  function toFileShape(definition) {
    const out = {
      id: definition.id,
      title: definition.title,
      port: definition.port,
      command: definition.command,
      cwd: definition.cwd,
      autostart: definition.autostart === true,
      autoStopOnExit: definition.autoStopOnExit !== false,
      takeover: definition.takeover === 'force' ? 'force' : 'match',
      match: { commandLinePattern: definition.match?.commandLinePattern ?? '' },
    }
    if (typeof definition.url === 'string' && definition.url !== '') out.url = definition.url
    if (typeof definition.host === 'string' && definition.host !== '' && definition.host !== '127.0.0.1') out.host = definition.host
    if (definition.env !== null && typeof definition.env === 'object' && Object.keys(definition.env).length > 0) out.env = definition.env
    if (definition.restartMode === 'supervisor') out.restartMode = 'supervisor'
    if (typeof definition.probe?.path === 'string' && definition.probe.path !== '') out.probe = definition.probe
    return out
  }

  /**
   * 从启动命令里识别端口：`--port N` / `-p N` / `PORT=N` / `:N`。
   * 表单允许不填端口（命令里通常已经写了），这里作为权威兜底；识别不到就保持 null（按进程状态判断）。
   */
  function portFromCommand(command) {
    const text = String(command ?? '')
    const patterns = [/--port[=\s]+(\d{2,5})/i, /-p[=\s]+(\d{2,5})/i, /PORT=(\d{2,5})/i, /:(\d{2,5})(?=\s|\/|$)/]
    for (const pattern of patterns) {
      const matched = pattern.exec(text)
      if (matched === null) continue
      const port = Number(matched[1])
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
    }
    return null
  }

  /** 由名称派生一个合法 id（表单不要求用户自己想 id）。 */
  function slugify(value) {
    const base = String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return base === '' ? 'service' : base.slice(0, 40)
  }

  function uniqueId(base, taken) {
    if (!taken.has(base)) return base
    for (let index = 2; index < 200; index += 1) {
      const candidate = `${base}-${index}`
      if (!taken.has(candidate)) return candidate
    }
    return `${base}-${Date.now()}`
  }

  /**
   * 表单写入路径：按 id 新增或更新一条服务定义，其余条目原样保留。
   * 仍然走 saveConfig（校验 + 原子写 + expectedRevision），所以并发保护与「配置即唯一真相」都不变。
   * @param {{service?: object, expectedRevision?: string}} payload
   */
  async function configUpsert(payload = {}) {
    const input = payload.service
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw fail('CONFIG_INVALID', 'config.upsert 需要 service 对象')
    const current = readConfig(configPath)
    if (current.issues.length) throw fail('CONFIG_INVALID', '配置含无效条目，请先修复再登记服务。', { issues: current.issues })
    if (typeof payload.expectedRevision !== 'string' || !payload.expectedRevision) throw fail('CONFIG_INVALID', 'config.upsert 需要 expectedRevision；请先 config.get。')
    const document = JSON.parse(current.raw)
    if (payload.registration === true) {
      const index = document.services.findIndex((entry) => entry.id.trim() === input.id)
      const merged = mergeRegistration(index < 0 ? null : document.services[index], input)
      if (index < 0) document.services.push(merged)
      else document.services[index] = merged
      const saved = saveConfig(configPath, JSON.stringify(document), payload.expectedRevision, { preserveFields: true })
      touch()
      return { path: saved.path, revision: saved.revision, configRevision: saved.revision, raw: saved.raw, id: input.id }
    }
    const existing = new Map(current.services.map((definition) => [definition.id, definition]))
    // 编辑既有 CLI 稳定 id 时不能把大小写/长 id 改写成另一个服务；新表单仍保留 slug 行为。
    const requestedId = typeof input.id === 'string' && input.id.trim() !== '' ? (existing.has(input.id) ? input.id : slugify(input.id)) : null
    const id = requestedId ?? uniqueId(slugify(input.title), new Set(existing.keys()))
    const before = existing.get(id) ?? null
    // 端口可以不填：命令里写了就从命令里识别（`--port 5173` 之类），识别不到则保持 null。
    const command = typeof input.command === 'string' && input.command.trim() !== '' ? input.command.trim() : (before?.command ?? '')
    const port = Number.isInteger(input.port) ? input.port : (portFromCommand(command) ?? before?.port ?? null)
    const merged = {
      ...(before ?? {}),
      ...input,
      id,
      title: typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : (before?.title ?? id),
      port,
      command,
      url: typeof input.url === 'string' && input.url.trim() !== '' ? input.url.trim() : null,
      host: typeof input.host === 'string' && input.host.trim() !== '' ? input.host.trim() : '127.0.0.1',
      match: { commandLinePattern: typeof input.match?.commandLinePattern === 'string' ? input.match.commandLinePattern : (before?.match?.commandLinePattern ?? '') },
      probe: {
        path: typeof input.probe?.path === 'string' && input.probe.path !== '' ? input.probe.path : null,
        expectStatus: Number.isInteger(input.probe?.expectStatus) ? input.probe.expectStatus : null,
        intervalMs: null,
      },
    }
    // 端口为空时按 URL/默认推导，避免留下「有端口却没写」的半成品。
    const checked = parseConfig(JSON.stringify({ services: [merged] }))
    if (checked.issues.length) throw fail('CONFIG_INVALID', '服务定义无效', { issues: checked.issues })
    const index = document.services.findIndex((entry) => entry.id.trim() === id)
    const result = { ...(index < 0 ? {} : document.services[index]) }
    // 保留扩展键，但不能让旧的可选字段复活（例如表单清空 probe.path）。
    for (const key of Object.keys(checked.services[0])) delete result[key]
    Object.assign(result, toFileShape(checked.services[0]))
    if (index < 0) document.services.push(result)
    else document.services[index] = result
    const saved = saveConfig(configPath, JSON.stringify(document), payload.expectedRevision, { preserveFields: true })
    touch()
    return { path: saved.path, revision: saved.revision, raw: saved.raw, id }
  }

  /**
   * 表单删除路径：删掉一条服务定义（不动任何正在运行的进程）。
   * @param {{id?: string, expectedRevision?: string}} payload
   */
  async function configRemove(payload = {}) {
    const id = requireId(payload)
    const current = readConfig(configPath)
    if (current.issues.length) throw fail('CONFIG_INVALID', '配置含无效条目，请先修复再删除服务。', { issues: current.issues })
    if (!current.services.some((definition) => definition.id === id)) {
      throw fail('SERVICE_NOT_FOUND', `配置里没有 id 为 ${id} 的服务`, { id })
    }
    if (typeof payload.expectedRevision !== 'string' || !payload.expectedRevision) throw fail('CONFIG_INVALID', 'config.remove 需要 expectedRevision；请先 config.get。')
    const document = JSON.parse(current.raw)
    document.services = document.services.filter((entry) => entry.id.trim() !== id)
    const saved = saveConfig(configPath, JSON.stringify(document), payload.expectedRevision, { preserveFields: true })
    touch()
    return { path: saved.path, revision: saved.revision, raw: saved.raw, id }
  }

  /** RPC 端点分发（唯一通道 /dsh-services）。 */
  async function handle(endpoint, payload) {
    switch (endpoint) {
      case 'snapshot': return snapshot(payload ?? {})
      case 'snapshot.fast': return snapshot({ mode: 'fast' })
      case 'snapshot.full': return snapshot({ mode: 'full' })
      case 'start': return start(requireId(payload), payload)
      case 'stop': return stop(requireId(payload), payload)
      case 'restart': return restart(requireId(payload), payload)
      case 'restart-dsh': return scheduleDshRestart(payload)
      case 'config.get': return configGet()
      case 'config.set': return configSet(payload)
      case 'config.upsert': return configUpsert(payload)
      case 'config.remove': return configRemove(payload)
      case 'logs': return logs(requireId(payload), payload)
      default: throw fail('UNKNOWN_ENDPOINT', `未知端点 ${endpoint}`)
    }
  }

  function requireId(payload) {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (id === '') throw fail('SERVICE_NOT_FOUND', '缺少服务 id')
    return id
  }

  return { handle, snapshot, start, stop, restart, autostart, dispose, scheduleDshRestart, configPath, logDir }
}
