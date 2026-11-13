/**
 * 服务配置：唯一事实来源是插件自己的 JSON 文件（设计决策 1 / 不变量 1）。
 *
 * - 运行态（谁在跑、PID、上次退出码）绝不写回这里。
 * - 写入是「单写者 + 临时文件 rename + expectedRevision」（不变量 5）。
 * - 无效条目被隔离成 issue，而不是让整份配置加载失败（设计 §2 读路径 1）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** DSH 主目录：显式 DSH_HOME 优先，其次 ~/.dsh。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

/** 插件自有的状态目录（配置 + 日志）。 */
export function defaultStateDir() {
  return path.join(dshHome(), '.dsh-services-manager')
}

export function defaultConfigPath() {
  return path.join(defaultStateDir(), 'services.json')
}

export function defaultLogDir() {
  return path.join(defaultStateDir(), 'logs')
}

/** 内容指纹，用作乐观并发的 revision。 */
export function revisionOf(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex').slice(0, 16)
}

/** 新安装不带任何本机定义；已有 services.json 原样保留。 */
export const DEFAULT_CONFIG = { version: 1, services: [] }

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

/** 校验一条服务定义；返回规范化后的定义或错误信息。 */
function normalizeDefinition(input, index) {
  const where = Number.isInteger(index) ? `services[${index}]` : 'service'
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: `${where} 必须是对象` }
  }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '' || !ID_PATTERN.test(id)) return { error: `${where}.id 缺失或非法（只允许字母数字与 . _ -）` }
  if (id === 'dsh') return { error: `${where}.id 不能是保留值 dsh（dsh 是内置条目）` }
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (command === '') return { error: `${where}.command 必填` }
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  if (cwd === '') return { error: `${where}.cwd 必填` }
  let port = null
  if (input.port !== undefined && input.port !== null) {
    port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `${where}.port 必须是 1-65535 的整数` }
  }
  const host = typeof input.host === 'string' && input.host.trim() !== '' ? input.host.trim() : '127.0.0.1'
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : id
  const takeover = input.takeover === 'force' ? 'force' : 'match'
  const restartMode = input.restartMode === 'supervisor' ? 'supervisor' : 'inline'
  const probeInput = input.probe !== null && typeof input.probe === 'object' ? input.probe : {}
  const probe = {
    path: typeof probeInput.path === 'string' && probeInput.path !== '' ? probeInput.path : null,
    expectStatus: Number.isInteger(probeInput.expectStatus) ? probeInput.expectStatus : null,
    intervalMs: Number.isInteger(probeInput.intervalMs) ? probeInput.intervalMs : null,
  }
  const matchInput = input.match !== null && typeof input.match === 'object' ? input.match : {}
  const match = {
    commandLinePattern: typeof matchInput.commandLinePattern === 'string' ? matchInput.commandLinePattern : '',
  }
  const env = {}
  if (input.env !== null && typeof input.env === 'object' && !Array.isArray(input.env)) {
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  return {
    definition: {
      id,
      title,
      port,
      host,
      url: typeof input.url === 'string' && input.url !== '' ? input.url : port === null ? null : `http://${host}:${port}/`,
      command,
      cwd,
      env,
      autostart: input.autostart === true,
      autoStopOnExit: input.autoStopOnExit !== false,
      probe,
      match,
      restartMode,
      takeover,
    },
  }
}

/**
 * 解析配置文本：条目级错误隔离，不整体失败。
 * @returns {{ services: object[], issues: {index:number,id:string,message:string}[] }}
 */
export function parseConfig(raw) {
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch (error) {
    return { services: [], issues: [{ index: -1, id: '', message: `配置不是合法 JSON：${error.message}` }] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { services: [], issues: [{ index: -1, id: '', message: '配置顶层必须是对象' }] }
  }
  if (!Array.isArray(parsed.services)) {
    return { services: [], issues: [{ index: -1, id: '', message: '配置缺少 services 数组' }] }
  }
  const services = []
  const issues = []
  const seen = new Set()
  parsed.services.forEach((entry, index) => {
    const result = normalizeDefinition(entry, index)
    if (result.error !== undefined) {
      issues.push({ index, id: typeof entry?.id === 'string' ? entry.id : '', message: result.error })
      return
    }
    if (seen.has(result.definition.id)) {
      issues.push({ index, id: result.definition.id, message: `services[${index}].id 与前面的条目重复` })
      return
    }
    seen.add(result.definition.id)
    services.push(result.definition)
  })
  return { services, issues }
}

/** 读取配置；文件不存在则写入默认配置。 */
export function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
  }
  const raw = fs.readFileSync(configPath, 'utf8')
  const { services, issues } = parseConfig(raw)
  return { raw, revision: revisionOf(raw), services, issues }
}

/** 同一宿主内同步提交意图：读最新整份配置，只改目标字段，不隔离丢弃坏条目。 */
export function setAutostart(configPath, id, autostart) {
  const current = readConfig(configPath)
  if (current.issues.length > 0) {
    const error = new Error('配置含无效条目，请先修复再修改启停策略。')
    error.code = 'CONFIG_INVALID'
    error.details = { path: configPath, issues: current.issues }
    throw error
  }
  const definition = current.services.find((entry) => entry.id === id)
  if (!definition) {
    const error = new Error(`没有 id 为 ${id} 的服务定义`)
    error.code = 'SERVICE_NOT_FOUND'
    throw error
  }
  const parsed = JSON.parse(current.raw)
  parsed.services.find((entry) => entry.id.trim() === id).autostart = autostart
  const saved = saveConfig(configPath, JSON.stringify(parsed), current.revision, { preserveFields: true })
  return { ...saved, definition: { ...definition, autostart } }
}

/** 供 config.get 使用：只读，不创建文件之外的副作用。 */
export function readConfigRaw(configPath) {
  const { raw, revision } = readConfig(configPath)
  return { raw, revision }
}

/**
 * 原子保存配置（单写者 + 临时文件 rename + expectedRevision）。
 * @throws {Error & {code:string, details?:object}} CONFIG_CONFLICT / CONFIG_INVALID
 */
export function saveConfig(configPath, raw, expectedRevision, { preserveFields = false } = {}) {
  const current = readConfig(configPath)
  if (typeof expectedRevision === 'string' && expectedRevision !== '' && expectedRevision !== current.revision) {
    const error = new Error('配置文件已被外部修改，请重新载入后再保存。')
    error.code = 'CONFIG_CONFLICT'
    error.details = { expectedRevision, actualRevision: current.revision, path: configPath }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (parseError) {
    const error = new Error(`配置不是合法 JSON：${parseError.message}`)
    error.code = 'CONFIG_INVALID'
    error.details = { path: configPath }
    throw error
  }
  const checked = parseConfig(raw)
  if (checked.issues.length > 0) {
    const error = new Error(`配置校验失败：${checked.issues.map((issue) => issue.message).join('；')}`)
    error.code = 'CONFIG_INVALID'
    error.details = { path: configPath, issues: checked.issues }
    throw error
  }
  // 规范化后写回：只保留已知字段，避免把任意键写进唯一真相。
  const normalized = {
    version: Number.isInteger(parsed?.version) ? parsed.version : 1,
    services: parsed.services.map((entry) => {
      const { definition } = normalizeDefinition(entry, 0)
      const out = {
        id: definition.id,
        title: definition.title,
        port: definition.port,
        url: definition.url,
        command: definition.command,
        cwd: definition.cwd,
        autostart: definition.autostart,
        autoStopOnExit: definition.autoStopOnExit,
        takeover: definition.takeover,
        match: definition.match,
      }
      if (definition.host !== '127.0.0.1') out.host = definition.host
      if (Object.keys(definition.env).length > 0) out.env = definition.env
      if (definition.restartMode !== 'inline') out.restartMode = definition.restartMode
      if (definition.probe.path !== null) out.probe = definition.probe
      return out
    }),
  }
  const text = `${JSON.stringify(preserveFields ? parsed : normalized, null, 2)}\n`
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const temporary = path.join(path.dirname(configPath), `.services.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temporary, text, 'utf8')
  fs.renameSync(temporary, configPath)
  return { raw: text, revision: revisionOf(text), path: configPath }
}
