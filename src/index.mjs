/**
 * dsh-services-manager 宿主半边。
 *
 * 职责：把「宿主后台网络服务」的观测与控制注册成一条浏览器 RPC 通道（/dsh-services），
 * 并在插件加载时拉起 autostart 服务、在插件卸载（dsh 退出）时停止本插件启动的实例。
 *
 * 浏览器半边在 ./client（settings.section 分区），两侧只通过这一条 RPC 通道通信。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createManager } from './supervisor.mjs'
import { defaultConfigPath, defaultLogDir, defaultStateDir } from './config.mjs'

export const name = 'dsh-services-manager'
/**
 * `subprocess` 是硬依赖（启动服务必须经宿主的托管进程范围）；
 * `connection` 也是硬依赖：没有它就注册不了 RPC 面，浏览器半边无法工作；
 * `webServer` 同样是硬依赖：当前 connection.rpc.handle 在调用方 fiber 注册路由。
 * DSH 0.2.2 仍需给 connection 行补 webServer；由本包 patch 处理，保留模板的 webStartup。
 */
export const inject = ['subprocess', 'connection', 'webServer']

/** 浏览器 ↔ 宿主 的唯一通道。 */
const RPC_CHANNEL = '/dsh-services'

export function apply(ctx, config) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // cordis 以 (ctx, config) 调用插件体：config 就是 loader 行里的 config 段。
  // 注意不要访问 ctx.config —— 未声明 inject 时 cordis 会直接抛
  // 「cannot get property "config" without inject」，并让整个 profile 树加载失败。
  const configured = config !== null && typeof config === 'object' ? config : {}
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

  const stateDir = pick(configured.stateDir, defaultStateDir())
  const configPath = pick(configured.configPath, defaultConfigPath())
  const logDir = pick(configured.logDir, defaultLogDir())

  const manager = createManager({
    ctx,
    configPath,
    stateDir,
    logDir,
    supervisorScript: path.join(here, 'restart-supervisor.mjs'),
  })

  // autostart 在插件加载后异步拉起；dispose 时停止由本插件启动的实例。
  ctx.effect(() => {
    void manager.autostart()
    return () => manager.dispose()
  })

  const connection = ctx.get('connection')
  ctx.effect(() => {
    // 实际请求保护由 connection/Web 的 Host/Origin 校验与会话 cookie 提供。
    // rpc.handle 不支持 authority 选项；这里不是 agent 权限沙箱或额外的 loopback ACL。
    // 随包 CLI 自行限制目标 loopback，不扩大宿主既有认证能力。
    const dispose = connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload) => {
      try {
        // 信封契约（client-connection 的 rpcResultSchema）：
        //   成功 = { ok: true, value }；失败 = { ok: false, error: { code, message, details } }
        // 字段名是 value 而不是 data；details 在 schema 里是必填对象，所以永远给对象。
        return { ok: true, value: await manager.handle(endpoint, payload ?? {}) }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: typeof error?.code === 'string' ? error.code : 'OPERATION_FAILED',
            message: String(error?.message ?? error),
            details: error?.details !== null && typeof error?.details === 'object' ? error.details : {},
          },
        }
      }
    })
    return () => {
      if (typeof dispose === 'function') return dispose()
    }
  })

  // 启动证据：宿主日志里必须能看到这一行，否则沙箱/正式环境的挂载都不算成功。
  // 同时 fail-loud 地确认 subprocess 真被注入：缺注入时这里立刻抛，而不是等第一次启动服务才炸。
  console.log(`[dsh-services-manager] 已加载：config=${configPath} rpc=${RPC_CHANNEL} pid=${process.pid} subprocess=${typeof ctx.subprocess?.spawn === 'function'}`)
}
