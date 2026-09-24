/**
 * 验证脚本共用的最小 seam 替身：真实启动子进程，但只实现宿主 `ctx.subprocess`
 * 与 `connection.rpc` 被插件用到的那一小部分面。
 *
 * 用途：不重启 dsh 就驱动真实的 `src/index.mjs`，核对宿主半边的行为。
 */
import { spawn } from 'node:child_process'

export function createFakeSeam({ configPath, stateDir, logDir }) {
  const handlers = new Map()
  const disposers = []

  const makeReader = (stream) => {
    let text = ''
    stream.on('data', (chunk) => { text += String(chunk) })
    return { readFrom: (from) => ({ text: text.slice(from), nextOffset: text.length }) }
  }

  const ctx = {
    config: { configPath, stateDir, logDir },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get(name) {
      if (name !== 'connection') return undefined
      return {
        rpc: {
          handle(channel, handler) {
            handlers.set(channel, handler)
            return () => handlers.delete(channel)
          },
        },
      }
    },
    subprocess: {
      spawn(spec) {
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let settled = false
        const done = new Promise((resolve) => {
          child.on('close', (code, signal) => { settled = true; resolve({ exitCode: code, signal }) })
        })
        return {
          collected: { stdout: makeReader(child.stdout), stderr: makeReader(child.stderr) },
          done,
          terminate() {
            try {
              spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            } catch { /* 进程可能已消失 */ }
          },
          async waitForExit() {
            for (let index = 0; index < 60 && !settled; index += 1) await new Promise((r) => setTimeout(r, 100))
            return settled
          },
        }
      },
    },
  }

  /** 调用 RPC 端点；失败时抛出带 code 的错误（与浏览器半边看到的一致）。 */
  async function invoke(endpoint, payload) {
    const handler = handlers.get('/dsh-services')
    if (typeof handler !== 'function') throw new Error('RPC 通道 /dsh-services 未注册')
    const result = await handler(endpoint, payload)
    if (result?.ok !== true) {
      const error = new Error(result?.error?.message ?? 'RPC 失败')
      error.code = result?.error?.code
      error.details = result?.error?.details
      throw error
    }
    return result.value
  }

  /** 插件加载时必须作为第二个参数传入的 config 段（宿主半边不再读 ctx.config）。 */
  const pluginConfig = { configPath, stateDir, logDir }

  return { ctx, disposers, invoke, pluginConfig }
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
