/**
 * 浏览器半边的无浏览器冒烟测试。
 *
 * 为什么需要：`lib/client.js` 是手写的 `__ModuleLoader__` bundle，没有构建链也没有类型检查；
 * 一个渲染期错误会让整个「服务管理」分区白屏。这里用 vm + 极简 React/document 替身把它渲染出来，
 * 断言关键分支（骨架 / tier1「读取中」 / 卡片 / 新鲜度文案 / 按钮走哪个端点 / data-* 状态驱动）。
 *
 * 只覆盖渲染与调用约定，不替代真机（真机由 `scripts/preview-sandbox.ps1` + `verify-rpc-http.mjs` 覆盖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const source = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** 把 bundle 载进隔离上下文，返回 factory 的返回值（{inject, apply}）与 hook 记录。 */
function loadBundle() {
  let registered = null
  const documentStub = {
    visibilityState: 'visible',
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { registered = definition } } },
    document: documentStub,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1 },
  }
  sandbox.window.document = documentStub
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  assert.ok(registered !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-services-manager')

  const states = []
  const effects = []
  let hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useState: (initial) => {
      const index = hookIndex
      hookIndex += 1
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useRef: (initial) => {
      const index = hookIndex
      hookIndex += 1
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
    Fragment: 'Fragment',
  }
  const plugin = registered.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  return {
    plugin,
    effects,
    /** 每次渲染前重置 hook 游标（state 数组保留，模拟同一实例的后续渲染）。 */
    beginRender: () => { hookIndex = 0; effects.length = 0 },
  }
}

/** 渲染一次组件，收集 className、data-* 与文本。 */
function render(component, props) {
  const raw = component(props)
  const classes = []
  const dataAttrs = []
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') {
      if (typeof node === 'string' || typeof node === 'number') texts.push(String(node))
      return
    }
    if (Array.isArray(node)) { node.forEach(walk); return }
    const propsOf = node.props || {}
    if (typeof propsOf.className === 'string') classes.push(propsOf.className)
    for (const [key, value] of Object.entries(propsOf)) {
      if (key.startsWith('data-')) dataAttrs.push(`${key}=${String(value)}`)
    }
    ;(node.children || []).forEach(walk)
  }
  walk(raw)
  return { raw, classes, dataAttrs, text: texts.join(' | ') }
}

/** 挂载 → 跑 effect（触发 fast/full 拉取）→ 等 promise 落地 → 用更新后的 state 重新渲染。 */
async function mountAndSettle(bundle, call) {
  bundle.beginRender()
  render(registeredComponent(bundle.plugin), { call })
  for (const effect of bundle.effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  bundle.beginRender()
  return render(registeredComponent(bundle.plugin), { call })
}

/** 取回 apply 注册进 settings.section 的组件。 */
function registeredComponent(plugin) {
  let component = null
  plugin.apply({
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    slots: {
      inject: (name, register) => register(),
      register: (definition, target) => { component = target; return () => {} },
    },
  })
  assert.ok(component !== null, 'apply 必须通过 settings.section 注册组件')
  return component
}

/** 假 call：按端点返回信封，并记录调用顺序。 */
function fakeCall(handlers) {
  const calls = []
  const call = async (endpoint, payload) => {
    calls.push({ endpoint, payload })
    const handler = handlers[endpoint]
    if (handler === undefined) return { ok: false, error: { code: 'UNKNOWN_ENDPOINT', message: 'no handler', details: {} } }
    return { ok: true, value: handler(payload) }
  }
  return { call, calls }
}

const service = (over) => ({
  id: 'mechanics-web', title: 'Mechanics Web', port: 4319, host: '127.0.0.1', url: 'http://127.0.0.1:4319/',
  autostart: false, autoStopOnExit: true, restartMode: 'inline', takeover: 'match',
  status: 'running', ownership: 'discovered', pid: 33876, healthy: null, commandLine: 'node cli.mjs web',
  lastExit: null, lastError: null, lastOperation: null, updatedAt: '2026-09-24T00:00:00.000Z', managed: true,
  ...over,
})

const snapshotValue = (over = {}, timing = {}) => ({
  revision: 3, configPath: 'C:/.dsh/.dsh-services-manager/services.json', configRevision: 'abc', stateDir: 'C:/.dsh/.dsh-services-manager',
  configIssues: [], summary: { total: 1, running: 1, stopped: 0, error: 0, unknown: 0 },
  services: [service()], mode: 'fast',
  timing: { collectedAt: 1, servedAt: 2, ageMs: 1, tier: 2, returnedFromCache: true, refreshing: false, degraded: false, revision: 3, cacheMiss: false, ...timing },
  ...over,
})

test('首帧 cacheMiss 渲染骨架，且不渲染计数', () => {
  const bundle = loadBundle()
  const { call } = fakeCall({
    'snapshot.fast': () => snapshotValue(
      { services: [], summary: { total: 0, running: 0, stopped: 0, error: 0, unknown: 0 } },
      { cacheMiss: true, tier: 1, returnedFromCache: false },
    ),
  })
  bundle.beginRender()
  const { classes, text } = render(registeredComponent(bundle.plugin), { call })
  assert.ok(classes.some((value) => value.includes('svc-skeleton')), 'cacheMiss 必须显示骨架')
  assert.ok(text.includes('服务管理'), '标题必须在')
  assert.ok(text.includes('共 0') === false, '骨架态不该同时给出「共 0」这类汇总')
})

test('tier 1 且无 pid 时显示「读取中…」而不是「未知」', async () => {
  const bundle = loadBundle()
  const { call } = fakeCall({ 'snapshot.fast': () => snapshotValue({ services: [service({ pid: null })] }, { tier: 1, returnedFromCache: false }) })
  const { text } = await mountAndSettle(bundle, call)
  assert.ok(text.includes('读取中…'), 'tier1 的 PID 必须显示读取中')
  assert.ok(text.includes('运行中'), '状态文案必须在')
  assert.ok(text.includes('详情读取中'), 'freshness 必须提示详情读取中')
})

test('正常快照渲染卡片、汇总与新鲜度文案', async () => {
  const bundle = loadBundle()
  const { call } = fakeCall({ 'snapshot.fast': () => snapshotValue() })
  const { classes, dataAttrs, text } = await mountAndSettle(bundle, call)
  assert.ok(classes.some((value) => value.includes('svc-card')), '必须渲染服务卡片')
  assert.ok(dataAttrs.includes('data-status=running'), '状态必须由 data-status 驱动')
  assert.ok(dataAttrs.includes('data-ownership=discovered'), '来源必须由 data-ownership 驱动')
  assert.ok(text.includes('快照缓存命中'), '新鲜度文案必须来自 timing')
  assert.ok(text.includes('Mechanics Web') && text.includes('33876'), '名称与 PID 必须在')
  assert.ok(text.includes('外部进程'), '来源文案必须在')
  assert.ok(text.includes('共 1'), '汇总必须在')
})

test('degraded/refreshing 会显示出来，error 卡片标记 stale 与 data-status', async () => {
  const bundle = loadBundle()
  const { call } = fakeCall({
    'snapshot.fast': () => snapshotValue({ services: [service({ status: 'error', lastError: '退出码 1' })] }, { degraded: true, refreshing: true }),
  })
  const { dataAttrs, text } = await mountAndSettle(bundle, call)
  assert.ok(text.includes('详情可能已过期') && text.includes('后台补齐中'), '新鲜度告警必须在')
  assert.ok(dataAttrs.includes('data-status=error'), 'error 状态必须在卡片上')
  assert.ok(dataAttrs.includes('data-stale=true'), 'degraded 必须落成 data-stale')
  assert.ok(text.includes('⚠'), '错误要有非颜色的第二信号')
})

test('挂载先走 snapshot.fast；点「全部刷新」走 snapshot.full', async () => {
  const bundle = loadBundle()
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue(),
    'snapshot.full': () => snapshotValue({}, { returnedFromCache: false }),
  })
  bundle.beginRender()
  const { raw } = render(registeredComponent(bundle.plugin), { call })
  for (const effect of bundle.effects) {
    const cleanup = effect()
    assert.equal(typeof cleanup, 'function', '每个 effect 必须返回清理函数')
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(calls.some((entry) => entry.endpoint === 'snapshot.fast'), '首屏必须用 fast')

  const findButton = (node, label) => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) { const found = findButton(child, label); if (found !== null) return found }
      return null
    }
    if (node.type === 'button' && (node.children || []).includes(label)) return node
    for (const child of node.children || []) { const found = findButton(child, label); if (found !== null) return found }
    return null
  }
  const refreshButton = findButton(raw, '全部刷新')
  assert.ok(refreshButton !== null, '必须有「全部刷新」按钮')
  await refreshButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(calls.some((entry) => entry.endpoint === 'snapshot.full'), '显式刷新必须走 full')
})
