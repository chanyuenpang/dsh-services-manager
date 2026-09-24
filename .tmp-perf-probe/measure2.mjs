// 只读性能探针 2：分别量化「冷 CIM」与「热缓存」两次 snapshot 的事件循环阻塞时长。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { createManager } from '../src/supervisor.mjs'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-perf2-'))
const configPath = path.join(stateDir, 'services.json')
const logDir = path.join(stateDir, 'logs')
const manager = createManager({
  ctx: { subprocess: { spawn() { throw new Error('no spawn') } } },
  configPath, stateDir, logDir, supervisorScript: path.join(stateDir, 'unused.mjs'),
})

const histogram = monitorEventLoopDelay({ resolution: 1 })
histogram.enable()

async function timed(label) {
  histogram.reset()
  const started = performance.now()
  await manager.handle('snapshot', {})
  const ms = performance.now() - started
  // 留一拍让直方图收集最后一个采样窗口
  await new Promise((r) => setTimeout(r, 20))
  return { label, totalMs: Math.round(ms), loopMaxMs: Number((histogram.max / 1e6).toFixed(1)), loopMeanMs: Number((histogram.mean / 1e6).toFixed(1)) }
}

const rows = []
rows.push(await timed('cold-1'))
rows.push(await timed('warm-2'))
rows.push(await timed('warm-3'))
// 让命令行 TTL（10s）过期后再测一次冷路径
await new Promise((r) => setTimeout(r, 10_200))
rows.push(await timed('cold-after-ttl'))
histogram.disable()
console.log(rows.map((r) => `${r.label}\ttotal=${r.totalMs}ms\tloopMax=${r.loopMaxMs}ms\tloopMean=${r.loopMeanMs}ms`).join('\n'))
