// 只读性能探针：对真实 host 半边代码测端到端延迟与事件循环阻塞。不启动/停止任何服务。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createManager } from '../src/supervisor.mjs'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-perf-'))
const configPath = path.join(stateDir, 'services.json')
const logDir = path.join(stateDir, 'logs')

const manager = createManager({
  ctx: { subprocess: { spawn() { throw new Error('perf probe must not spawn') } } },
  configPath,
  stateDir,
  logDir,
  supervisorScript: path.join(stateDir, 'unused.mjs'),
})

const histogram = monitorEventLoopDelay({ resolution: 5 })
histogram.enable()

const samples = []
for (let index = 1; index <= 5; index += 1) {
  const started = process.hrtime.bigint()
  let lagBefore = histogram.max
  histogram.reset()
  const snapshot = await manager.handle('snapshot', {})
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  samples.push({
    run: index,
    ms: Math.round(ms),
    revision: snapshot.revision,
    summary: snapshot.summary,
    services: snapshot.services.map((s) => `${s.id}:${s.status}:${s.ownership}:pid=${s.pid ?? '-'}`),
    loopMaxMs: Number.isFinite(histogram.max) ? Math.round(histogram.max / 1e6) : null,
    loopMeanMs: Number.isFinite(histogram.mean) ? Math.round(histogram.mean / 1e6) : null,
    prevWindowMaxMs: Number.isFinite(lagBefore) ? Math.round(lagBefore / 1e6) : null,
  })
}
histogram.disable()
console.log(JSON.stringify({ samples }, null, 2))
