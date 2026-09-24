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

/** 统计一次 snapshot 期间 10ms 定时器实际触发的次数（阻塞越久，次数越少）。 */
async function measure(label) {
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 10)
  const started = Date.now()
  const snapshot = await invoke('snapshot')
  const elapsed = Date.now() - started
  clearInterval(timer)
  const expected = Math.floor(elapsed / 10)
  console.log(
    `${label}: ${elapsed}ms | 事件循环 tick ${ticks}/${expected}` +
    ` | 服务 ${snapshot.services.length}（${snapshot.services.map((s) => `${s.id}=${s.status}`).join(', ')}）`,
  )
  return { elapsed, ticks, expected }
}

const cold = await measure('第 1 次（冷）')
const warm = []
for (let index = 2; index <= rounds; index += 1) warm.push(await measure(`第 ${index} 次`))

const times = [cold, ...warm].map((item) => item.elapsed).sort((a, b) => a - b)
const median = times[Math.floor(times.length / 2)]
const blocked = [cold, ...warm].filter((item) => item.expected >= 5 && item.ticks <= 1).length
console.log(`\n中位耗时：${median}ms | 最小 ${times[0]}ms | 最大 ${times[times.length - 1]}ms`)
console.log(`事件循环被阻塞的轮数：${blocked}/${times.length}（判据：期望 tick ≥5 时实际 ≤1）`)

// 快层：首屏路径 —— 只做本机 TCP 探测 + 读现有详层，不等 netstat/PowerShell。
console.log('\n--- 快层 mode=fast（首屏路径）---')
const fastTimes = []
for (let index = 1; index <= rounds; index += 1) {
  const started = Date.now()
  const fastSnapshot = await invoke('snapshot', { mode: 'fast' })
  const elapsedMs = Date.now() - started
  fastTimes.push(elapsedMs)
  const missingPid = fastSnapshot.services.filter((service) => service.pid === null).length
  console.log(
    `fast #${index}: ${elapsedMs}ms | stale=${String(fastSnapshot.stale)} refreshing=${String(fastSnapshot.refreshing)}` +
    ` ageMs=${String(fastSnapshot.ageMs)} | 缺 pid 的服务 ${missingPid}/${fastSnapshot.services.length}`,
  )
}
const fastSorted = [...fastTimes].sort((a, b) => a - b)
console.log(`快层中位：${fastSorted[Math.floor(fastSorted.length / 2)]}ms | 最小 ${fastSorted[0]}ms | 最大 ${fastSorted[fastSorted.length - 1]}ms`)
