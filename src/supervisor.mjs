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
import { spawn } from 'node:child_process'
import path from 'node:path'
import { launchArgv } from './command.mjs'
import {
  commandLines, killTree, listListeners, matchesSignature, tcpProbe,
  waitForPortFree, waitForPortListening,
} from './probe.mjs'
import { readConfig, saveConfig } from './config.mjs'

/** dsh 自身的保留 id。 */
export const SELF_ID = 'dsh'
const START_WAIT_MS = 8000
const STOP_WAIT_MS = 8000
/** spawn 出来的服务进程 stdout/stderr 的内存保留窗口与完整落盘上限。 */
const COLLECT_MAX_BYTES = 65536
const SPILL_MAX_BYTES = 16 * 1024 * 1024
const GRACE_MS = 10_000

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
export function createManager({ ctx, configPath, stateDir, logDir, supervisorScript }) {
  /** @type {Map<string, {handle:any, pending:string|null, startedAt:number|null, lastExit:{code:number|null,at:string}|null, lastError:string|null, lastOperation:string|null, updatedAt:string}>} */
  const instances = new Map()
  /** 每服务一条串行链：重复点击不会产生并发操作。 */
  const chains = new Map()
  let revision = 0
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

  /** 本实例监听端口：优先 netstat 确认结果，其次 --port 参数，最后 3080（快层不能依赖 netstat）。 */
  function argvSelfPort() {
    const index = process.argv.findIndex((arg) => arg === '--port')
    const explicit = index === -1 ? Number.NaN : Number(process.argv[index + 1])
    return Number.isInteger(explicit) ? explicit : 3080
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
      title: 'DSH Web（本实例）',
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

  async function findDefinition(id) {
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
      ownership = instance?.handle != null ? 'spawned' : 'discovered'
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

  function stateDirReady() {
    // 目录由 config/probe 各自按需创建；此处只保证日志目录存在。
    return logDir
  }

  /** 启动一条服务（幂等：已在监听则原样返回快照）。 */
  async function start(id, options = {}) {
    return enqueue(id, async () => {
      const definition = await findDefinition(id)
      if (definition.self === true) throw fail('OPERATION_FAILED', 'dsh 自身已在运行；请使用「重启 DSH」。')
      const listeners = await listListeners()
      const instance = instanceOf(id)
      if (definition.port !== null && listeners.has(definition.port)) {
        // 端口已在监听：不重启、不接管，如实返回当前状态。
        return snapshot()
      }
      if (instance.handle != null && instance.handleAlive !== false) {
        // 已有我们启动的实例：视为幂等重复调用。
        return snapshot()
      }
      instance.pending = 'starting'
      instance.lastError = null
      instance.lastStopAt = null
      instance.lastOperation = 'start'
      instance.updatedAt = now()
      try {
        const handle = ctx.subprocess.spawn({
          argv: launchArgv(definition.command),
          cwd: definition.cwd,
          env: { ...definition.env },
          stdio: {
            stdin: 'ignore',
            stdout: { mode: 'collect', maxBytes: COLLECT_MAX_BYTES, spill: { maxBytes: SPILL_MAX_BYTES } },
            stderr: { mode: 'collect', maxBytes: COLLECT_MAX_BYTES, spill: { maxBytes: SPILL_MAX_BYTES } },
          },
          graceMs: GRACE_MS,
        })
        instance.handle = handle
        instance.handleAlive = true
        instance.startedAt = Date.now()
        instance.pending = 'starting'
        handle.done.then((outcome) => {
          instance.handleAlive = false
          instance.lastExit = { code: outcome.exitCode, at: now() }
          // 我们主动 stop 造成的非零退出不是异常（lastStopAt 在 start 时清空）。
          if (outcome.exitCode !== 0 && outcome.exitCode !== null && instance.lastStopAt === null) {
            instance.lastError = `进程退出，退出码 ${outcome.exitCode}`
          }
          instance.updatedAt = now()
        }).catch((error) => {
          instance.handleAlive = false
          instance.lastError = `子进程失败：${String(error?.message ?? error)}`
          instance.updatedAt = now()
        })
      } catch (error) {
        instance.pending = null
        instance.lastError = `启动失败：${String(error?.message ?? error)}`
        instance.lastOperation = 'start'
        instance.updatedAt = now()
        throw fail('OPERATION_FAILED', instance.lastError)
      }
      instance.pending = null
      instance.updatedAt = now()
      if (definition.port !== null) {
        const listening = await waitForPortListening(definition.port, { timeoutMs: START_WAIT_MS })
        if (!listening) {
          instance.lastError = `启动后 ${START_WAIT_MS}ms 内端口 ${definition.port} 未进入监听`
          instance.updatedAt = now()
        }
      }
      stateDirReady()
      return snapshot()
    })
  }

  /** 停止一条服务：先收自己的 handle，再按端口 + 签名接管外部占用者。 */
  async function stop(id, options = {}) {
    return enqueue(id, async () => {
      const definition = await findDefinition(id)
      if (definition.self === true) {
        throw fail('OPERATION_FAILED', '不能停止 dsh 自身（那会终止承载本页面的进程）；请使用「重启 DSH」。')
      }
      const instance = instanceOf(id)
      instance.pending = 'stopping'
      instance.lastOperation = 'stop'
      instance.lastStopAt = now()
      instance.updatedAt = now()
      try {
        if (instance.handle != null) {
          instance.handle.terminate()
          try {
            await instance.handle.waitForExit(AbortSignal.timeout(STOP_WAIT_MS))
          } catch {
            // 观察不到托管范围时继续走端口接管路径，不吞掉失败（下面会如实上报）。
          }
          instance.handleAlive = false
        }
        if (definition.port !== null) {
          let pid = (await listListeners()).get(definition.port)
          if (pid !== undefined) {
            // 不变量 7：终止判据必须用当次实时命令行，不得用可能过期的缓存。
            const occupantCommandLine = (await commandLines([pid], { fresh: true })).get(pid) ?? ''
            const signatureMatched = matchesSignature(occupantCommandLine, definition.match?.commandLinePattern)
            const allowed = options.force === true || definition.takeover === 'force' || signatureMatched
            if (!allowed) {
              throw fail('PORT_OWNED_BY_OTHER',
                `端口 ${definition.port} 被一个签名不匹配的进程占用（pid ${pid}），已拒绝终止。`,
                { port: definition.port, pid, commandLine: occupantCommandLine, pattern: definition.match?.commandLinePattern ?? '' })
            }
            await killTree(pid)
            const free = await waitForPortFree(definition.port, { timeoutMs: STOP_WAIT_MS })
            if (!free) {
              instance.lastError = `已发出终止命令，但 ${STOP_WAIT_MS}ms 内端口 ${definition.port} 仍未释放（pid ${pid}）`
              throw fail('TIMEOUT', instance.lastError, { port: definition.port, pid })
            }
          }
        }
        instance.lastError = null
      } finally {
        instance.pending = null
        instance.updatedAt = now()
      }
      return snapshot()
    })
  }

  /** 重启一条服务：stop → start（dsh 自身走看守进程）。 */
  async function restart(id, options = {}) {
    const definition = await findDefinition(id)
    if (definition.self === true || definition.restartMode === 'supervisor') {
      return scheduleDshRestart(options)
    }
    await stop(id, options)
    return start(id, options)
  }

  /**
   * 安排 dsh 自我重启：分离看守进程（复用 dsh-restart skill 的已验证形态）。
   * grace 不可静默为 0：默认 60s，下限 15s。
   */
  async function scheduleDshRestart(options = {}) {
    const stamp = Date.now()
    if (scheduledRestart !== null && stamp < scheduledRestart.executeAt + 60_000) {
      throw fail('ALREADY_SCHEDULED', '已经安排过一次 dsh 重启，不会重复启动看守进程。', {
        scheduledAt: scheduledRestart.scheduledAt,
        graceMs: scheduledRestart.graceMs,
      })
    }
    const listeners = await listListeners()
    const port = detectSelfPort(listeners)
    const requested = Number(options.graceSeconds ?? 60)
    const graceSeconds = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 15), 3600) : 60
    const args = [
      supervisorScript,
      '--apply',
      '--grace', String(graceSeconds),
      '--port', String(port),
      '--cwd', process.cwd(),
      '--log-dir', logDir,
    ]
    if (options.keepSandboxes === true) args.push('--keep-sandboxes')
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
    }
    return {
      accepted: true,
      graceMs: scheduledRestart.graceMs,
      logPath: scheduledRestart.logPath,
      scheduledAt: scheduledRestart.scheduledAt,
      port,
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
      if (definition.autostart !== true) continue
      try {
        await start(definition.id, {})
        console.log(`[dsh-services-manager] autostart 已拉起 ${definition.id}`)
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
    const autoStopIds = new Set(list.filter((definition) => definition.autoStopOnExit !== false).map((definition) => definition.id))
    for (const [id, instance] of instances) {
      if (instance.handle == null) continue
      if (!autoStopIds.has(id)) continue
      try {
        instance.handle.terminate()
      } catch { /* 托管范围可能已消失 */ }
    }
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
