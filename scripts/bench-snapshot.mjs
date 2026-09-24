/**
 * 观测量化：宿主观测的真实耗时基线，以及「事件循环是否被阻塞」的测法。
 *
 * 为什么需要它：v2 的验收是「快照先行 + 探测不阻塞事件循环」，这必须能前后对比。
 * 这里用 fake seam 驱动**真实的** `snapshot()`（真的跑 netstat 与 PowerShell），
 * 并用一个 10ms 定时器统计 snapshot 期间事件循环还转了几圈 —— 同步 execFileSync 会让它接近 0。
 *
 * 用法：node scripts/bench-snapshot.mjs [rounds]
 * 只读：使用真实 DSH_HOME 的配置文件（已存在则不会写），不启动/停止任何服务。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.mjs'
import { commandLines, listListeners } from '../src/probe.mjs'
import { createFakeSeam } from './fake-seam.mjs'
import { defaultConfigPath } from '../src/config.mjs'

const rounds = Number(process.argv[2] ?? 5)
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-bench-'))
const configPath = defaultConfigPath()
const logDir = path.join(stateDir, 'logs')

console.log(`配置（只读）：${configPath}`)
console.log(`轮数：${rounds}\n`)

// 分项基线：单次 netstat 与单次按 PID 取命令行
const listenerStart = Date.now()
const listeners = await listListeners()
const listenerMs = Date.now() - listenerStart
const pids = [...listeners.values()].slice(0, 4)
const commandStart = Date.now()
await commandLines(pids)
const commandMs = Date.now() - commandStart
console.log(`分项基线：netstat ${listenerMs}ms（${listeners.size} 个监听端口）；CIM 取命令行(${pids.length} pid) ${commandMs}ms\n`)

const { ctx, invoke, pluginConfig } = createFakeSeam({ configPath, stateDir, logDir })
apply(ctx, pluginConfig)

/**
 * 统计一次 snapshot 期间**心跳最坏间隔**（10ms 定时器相邻两次触发的最大间隔）。
 * 为什么不用 `monitorEventLoopDelay`：对同步阻塞不敏感（实测 1813ms 阻塞时它只报 16ms）；
 * 也不用「tick 总数」：异步化后单次阻塞仍有 70–216ms，只看总数会得出「没有阻塞」的错误结论。
 */
async function measure(label, endpoint = 'snapshot.full') {
  const gaps = []
  let last = Date.now()
  const timer = setInterval(() => {
    const at = Date.now()
    gaps.push(at - last)
    last = at
  }, 10)
  const started = Date.now()
  const snapshot = await invoke(endpoint, endpoint === 'snapshot.fast' ? { mode: 'fast' } : {})
  const elapsed = Date.now() - started
  clearInterval(timer)
  const worst = gaps.length === 0 ? elapsed : Math.max(...gaps)
  const timing = snapshot.timing ?? {}
  console.log(
    `${label}: ${elapsed}ms | 心跳最坏间隔 ${worst}ms | tick ${gaps.length}` +
    ` | tier=${String(timing.tier)} cache=${String(timing.returnedFromCache)} ageMs=${String(timing.ageMs)}` +
    ` | 服务 ${snapshot.services.length}（${snapshot.services.map((s) => `${s.id}=${s.status}`).join(', ')}）`,
  )
  return { elapsed, worst }
}

const cold = await measure('第 1 次（冷）')
const warm = []
for (let index = 2; index <= rounds; index += 1) warm.push(await measure(`第 ${index} 次`))

const worstGaps = [cold, ...warm].map((item) => item.worst)
const blocked = worstGaps.filter((gap) => gap > 50).length
const times = [cold, ...warm].map((item) => item.elapsed).sort((a, b) => a - b)
const median = times[Math.floor(times.length / 2)]
console.log(`\n中位耗时：${median}ms | 最小 ${times[0]}ms | 最大 ${times[times.length - 1]}ms`)
console.log(`心跳最坏间隔：${Math.max(...worstGaps)}ms（判据：>50ms 记为一次可感阻塞）`)
console.log(`可感阻塞轮数：${blocked}/${worstGaps.length}`)

// 快层：首屏路径 —— 命中快照缓存则 0ms 返回，未命中只做本机 TCP 探测，绝不等 netstat/PowerShell。
console.log('\n--- 快层 snapshot.fast（首屏路径）---')
const fastTimes = []
for (let index = 1; index <= rounds; index += 1) {
  const started = Date.now()
  const fastSnapshot = await invoke('snapshot.fast')
  const elapsedMs = Date.now() - started
  fastTimes.push(elapsedMs)
  const timing = fastSnapshot.timing ?? {}
  const missingPid = fastSnapshot.services.filter((service) => service.pid === null).length
  console.log(
    `fast #${index}: ${elapsedMs}ms | cached=${String(timing.returnedFromCache)} tier=${String(timing.tier)}` +
    ` degraded=${String(timing.degraded)} refreshing=${String(timing.refreshing)} ageMs=${String(timing.ageMs)}` +
    ` cacheMiss=${String(timing.cacheMiss)} | 缺 pid 的服务 ${missingPid}/${fastSnapshot.services.length}`,
  )
}
const fastSorted = [...fastTimes].sort((a, b) => a - b)
console.log(`快层中位：${fastSorted[Math.floor(fastSorted.length / 2)]}ms | 最小 ${fastSorted[0]}ms | 最大 ${fastSorted[fastSorted.length - 1]}ms`)
