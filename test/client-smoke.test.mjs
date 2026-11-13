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
function loadBundle({ confirm = () => { throw new Error("unexpected confirmation") } } = {}) {
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
    window: { confirm, __ModuleLoader__: { load: (definition) => { registered = definition } } },
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

/** 渲染一次组件，收集 className、data-*、title 与文本。 */
function render(component, props) {
  const raw = component(props)
  const classes = []
  const dataAttrs = []
  const titles = []
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') {
      if (typeof node === 'string' || typeof node === 'number') texts.push(String(node))
      return
    }
    if (Array.isArray(node)) { node.forEach(walk); return }
    const propsOf = node.props || {}
    if (typeof propsOf.className === 'string') classes.push(propsOf.className)
    if (typeof propsOf.title === 'string') titles.push(propsOf.title)
    for (const [key, value] of Object.entries(propsOf)) {
      if (key.startsWith('data-')) dataAttrs.push(`${key}=${String(value)}`)
    }
    ;(node.children || []).forEach(walk)
  }
  walk(raw)
  return { raw, classes, dataAttrs, titles, text: texts.join(' | ') }
}

/** 元素的纯文本（含嵌套子节点），用于按文案找按钮。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/** 在渲染树里按按钮文案 / hover 标题 / 无障碍名找按钮（按钮只留图标，文字在 title 与 aria-label 里）。 */
function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const found = findButton(child, label); if (found !== null) return found }
    return null
  }
  if (node.type === 'button') {
    const props = node.props || {}
    const names = [textOf(node), props.title, props['aria-label']].filter((value) => typeof value === 'string')
    if (names.some((value) => value.includes(label))) return node
  }
  for (const child of node.children || []) { const found = findButton(child, label); if (found !== null) return found }
  return null
}

/** 按 className 收集元素（表单输入用）。 */
function findByClass(node, className, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach((child) => findByClass(child, className, found)); return found }
  if (node.props && node.props.className === className) found.push(node)
  ;(node.children || []).forEach((child) => findByClass(child, className, found))
  return found
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
    const value = await handler(payload)
    return value && value.ok === false ? value : { ok: true, value }
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
  const { classes, dataAttrs, titles, text } = await mountAndSettle(bundle, call)
  assert.ok(classes.some((value) => value.includes('svc-card')), '必须渲染服务卡片')
  assert.ok(dataAttrs.includes('data-status=running'), '状态必须由 data-status 驱动')
  assert.ok(dataAttrs.includes('data-ownership=discovered'), '来源必须由 data-ownership 驱动')
  assert.ok(text.includes('快照缓存命中'), '新鲜度文案必须来自 timing')
  assert.ok(text.includes('Mechanics Web') && text.includes('33876'), '名称与 PID 必须在')
  assert.ok(titles.some((value) => value.includes('外部进程')), '来源的语义放在 tooltip 里')
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

  const refreshButton = findButton(raw, '全部刷新')
  assert.ok(refreshButton !== null, '必须有「全部刷新」按钮')
  await refreshButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(calls.some((entry) => entry.endpoint === 'snapshot.full'), '显式刷新必须走 full')
})

test('编辑：挂载时没取到配置，点「编辑」也会当场取回定义并填好表单', async () => {
  const bundle = loadBundle()
  const entryRaw = JSON.stringify({
    version: 1,
    services: [{
      id: 'mechanics-web', title: 'Mechanics Web', port: 4319,
      command: 'node cli.mjs web', cwd: 'G:\\Projects\\mechanics',
      autostart: true, autoStopOnExit: false, match: { commandLinePattern: 'cli\\.mjs' },
    }],
  })
  let configCalls = 0
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue(),
    'snapshot.full': () => snapshotValue(),
    // 第一次（挂载期）故意返回空值，模拟「先前那次取配置没成功」
    'config.get': () => { configCalls += 1; return configCalls === 1 ? null : { path: 'C:/.dsh/.dsh-services-manager/services.json', revision: 'rev-1', raw: entryRaw } },
  })
  const mounted = await mountAndSettle(bundle, call)
  const editButton = findButton(mounted.raw, '编辑')
  assert.ok(editButton !== null, '每行必须有「编辑」按钮')
  editButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))   // startEdit 是异步的（必要时当场取配置）
  await new Promise((resolve) => setTimeout(resolve, 0))
  bundle.beginRender()
  const opened = render(registeredComponent(bundle.plugin), { call })
  assert.ok(opened.classes.some((value) => value.includes('svc-form')), '点「编辑」必须打开表单（当场取配置）')
  const inputs = findByClass(opened.raw, 'svc-input')
  assert.equal(inputs[0].props.value, 'Mechanics Web', '名称必须按定义预填')
  assert.equal(inputs[2].props.value, 'node cli.mjs web', '启动命令必须按定义预填')
  assert.ok(configCalls >= 2, '应当在点开表单时重新取过一次配置')
  assert.ok(calls.some((entry) => entry.endpoint === 'config.get'), '必须真的请求过 config.get')
})

test('内置条目（dsh 自身，managed:false）不显示编辑/启停，只给「重启 DSH」', async () => {
  const bundle = loadBundle()
  const { call } = fakeCall({
    'snapshot.fast': () => snapshotValue({
      services: [{
        ...service({ id: 'dsh', title: 'DSH Web（本实例）', port: 3099, pid: 1234, status: 'running', ownership: 'none', managed: false }),
      }],
      summary: { total: 1, running: 1, stopped: 0, error: 0, unknown: 0 },
    }),
  })
  const { raw, text } = await mountAndSettle(bundle, call)
  assert.ok(text.includes('DSH Web（本实例）'), '内置条目必须渲染')
  assert.equal(findButton(raw, '编辑配置'), null, '内置条目不得有「编辑配置」')
  assert.equal(findButton(raw, '启动'), null, '内置条目不得有「启动」')
  assert.equal(findButton(raw, '停止'), null, '内置条目不得有「停止」')
  assert.ok(findButton(raw, '重启 DSH Web') !== null, '内置 Web 条目必须能一键重启 DSH Web')
})

test('DSH restart confirms interruption before scheduling exactly three seconds', async () => {
  for (const agreed of [false, true]) {
    const notices = []
    const bundle = loadBundle({ confirm: (message) => { notices.push(message); return agreed } })
    const { call, calls } = fakeCall({
      'snapshot.fast': () => snapshotValue({ services: [service({ id: 'dsh', managed: false })] }),
      'restart-dsh': ({ graceSeconds }) => ({ graceMs: graceSeconds * 1000, scheduledAt: '2026-09-29T12:00:00.000Z' }),
    })
    const { raw } = await mountAndSettle(bundle, call)
    assert.equal(calls.filter((entry) => entry.endpoint === 'restart-dsh').length, 0)
    const button = findButton(raw, '重启 DSH Web')
    assert.ok(button !== null)
    button.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notices.length, 1)
    assert.match(notices[0], /约 3 秒开始停旧进程/)
    assert.match(notices[0], /正在生成的回复或工具任务可能中断/)
    const scheduled = calls.filter((entry) => entry.endpoint === 'restart-dsh')
    assert.equal(scheduled.length, agreed ? 1 : 0)
    if (agreed) {
      assert.equal(scheduled[0].payload.graceSeconds, 3)
      bundle.beginRender()
      const updated = render(registeredComponent(bundle.plugin), { call })
      assert.ok(updated.text.includes('不是恢复完成时间'))
      assert.ok(updated.text.includes('安排时刻：'))
    }
  }
})

test('Desktop 自身条目使用应用重启文案且只描述当前应用树', async () => {
  const notices = []
  const bundle = loadBundle({ confirm: (message) => { notices.push(message); return true } })
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue({ services: [service({ id: 'dsh', title: 'DSH Desktop（本应用）', managed: false, runtimeKind: 'desktop', canRestartHost: true })] }),
    'restart-dsh': ({ graceSeconds }) => ({ graceMs: graceSeconds * 1000, runtimeKind: 'desktop' }),
  })
  const { raw } = await mountAndSettle(bundle, call)
  const button = findButton(raw, '重启 DSH Desktop 应用')
  assert.ok(button !== null)
  button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(notices[0], /DSH Desktop 应用/)
  assert.match(notices[0], /不会清扫其它 DSH 实例/)
  assert.doesNotMatch(notices[0], /新实例的 token/)
  assert.equal(calls.filter((entry) => entry.endpoint === 'restart-dsh').length, 1)
  bundle.beginRender()
  assert.ok(render(registeredComponent(bundle.plugin), { call }).text.includes('当前应用会关闭并自动重新打开'))
})

test('表单：填完保存走 config.upsert（不需要用户写 JSON）', async () => {
  const bundle = loadBundle()
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue(),
    'snapshot.full': () => snapshotValue(),
    'config.get': () => ({
      path: 'C:/.dsh/.dsh-services-manager/services.json', revision: 'rev-1',
      raw: JSON.stringify({ version: 1, services: [] }),
    }),
    'config.upsert': (payload) => ({ path: 'p', revision: 'rev-2', raw: '{"version":1,"services":[]}', id: 'demo' }),
  })
  const mounted = await mountAndSettle(bundle, call)
  assert.ok(calls.some((entry) => entry.endpoint === 'config.get'), '挂载时必须取一次配置拿 expectedRevision')

  const addButton = findButton(mounted.raw, '添加服务')
  assert.ok(addButton !== null, '必须有「添加服务」按钮')
  addButton.props.onClick()
  bundle.beginRender()
  const opened = render(registeredComponent(bundle.plugin), { call })
  assert.ok(opened.classes.some((value) => value.includes('svc-form')), '点「添加服务」必须出现表单')

  const inputs = findByClass(opened.raw, 'svc-input')
  assert.ok(inputs.length >= 4, '表单至少有名称/端口/启动命令/工作目录四个输入')
  inputs[0].props.onChange({ target: { value: 'Demo 服务' } })
  inputs[1].props.onChange({ target: { value: '4599' } })
  inputs[2].props.onChange({ target: { value: 'node demo.mjs' } })
  inputs[3].props.onChange({ target: { value: 'G:\\tmp' } })
  bundle.beginRender()
  const filled = render(registeredComponent(bundle.plugin), { call })
  const saveButton = findButton(filled.raw, '保存')
  assert.ok(saveButton !== null, '表单必须有保存按钮')
  await saveButton.props.onClick()

  const upsert = calls.find((entry) => entry.endpoint === 'config.upsert')
  assert.ok(upsert !== undefined, '保存必须走 config.upsert 而不是整份 JSON')
  assert.equal(upsert.payload.expectedRevision, 'rev-1', '必须带 expectedRevision 做并发保护')
  assert.equal(upsert.payload.service.title, 'Demo 服务')
  assert.equal(upsert.payload.service.port, 4599)
  assert.equal(upsert.payload.service.command, 'node demo.mjs')
  assert.equal(upsert.payload.service.cwd, 'G:\\tmp')
})

test('端口可留空：只填启动命令也能自动识别出端口', async () => {
  const bundle = loadBundle()
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue(),
    'snapshot.full': () => snapshotValue(),
    'config.get': () => ({ path: 'p', revision: 'rev-1', raw: JSON.stringify({ version: 1, services: [] }) }),
    'config.upsert': () => ({ revision: 'rev-2', raw: '{}' }),
  })
  const mounted = await mountAndSettle(bundle, call)
  findButton(mounted.raw, '添加服务').props.onClick()
  bundle.beginRender()
  const opened = render(registeredComponent(bundle.plugin), { call })
  const inputs = findByClass(opened.raw, 'svc-input')
  inputs[0].props.onChange({ target: { value: 'Demo' } })
  inputs[2].props.onChange({ target: { value: 'npm run dev -- --port 5173' } })   // 端口故意不填
  inputs[3].props.onChange({ target: { value: 'G:\\tmp' } })                      // 工作目录是必填项
  bundle.beginRender()
  const filled = render(registeredComponent(bundle.plugin), { call })
  const portInput = findByClass(filled.raw, 'svc-input')[1]
  assert.equal(portInput.props.value, '5173', '端口必须从启动命令里识别并预填')

  await findButton(filled.raw, '保存').props.onClick()
  const upsert = calls.find((entry) => entry.endpoint === 'config.upsert')
  assert.equal(upsert.payload.service.port, 5173, '提交时也必须带上识别到的端口')
})

test('表单校验：缺名称/命令/目录时给出可读错误且不发请求', async () => {
  const bundle = loadBundle()
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue(),
    'snapshot.full': () => snapshotValue(),
    'config.get': () => ({ path: 'p', revision: 'rev-1', raw: JSON.stringify({ version: 1, services: [] }) }),
    'config.upsert': () => ({ revision: 'rev-2', raw: '{}' }),
  })
  const mounted = await mountAndSettle(bundle, call)
  findButton(mounted.raw, '添加服务').props.onClick()
  bundle.beginRender()
  const opened = render(registeredComponent(bundle.plugin), { call })
  const saveButton = findButton(opened.raw, '保存')
  await saveButton.props.onClick()
  bundle.beginRender()
  const failed = render(registeredComponent(bundle.plugin), { call })
  assert.ok(failed.text.includes('必填'), '必须给出行内校验错误')
  assert.ok(!calls.some((entry) => entry.endpoint === 'config.upsert'), '校验失败不得发出写请求')
})

const configValue = (revision, autostart = false) => ({
  path: 'test/services.json', revision,
  raw: JSON.stringify({ version: 1, services: [{
    id: 'mechanics-web', title: 'Mechanics Web', port: 4319,
    command: 'node cli.mjs web', cwd: 'G:/test', autostart,
  }] }),
})

function rerender(bundle, call) {
  bundle.beginRender()
  return render(registeredComponent(bundle.plugin), { call })
}

async function clickAndSettle(tree, label) {
  const button = findButton(tree.raw, label)
  assert.ok(button, label)
  assert.notEqual(button.props.disabled, true, label + ' must be enabled')
  button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

for (const status of ['running', 'stopped']) {
  for (const autostart of [true, false]) {
    test('policy buttons independent of actual status: ' + status + '/' + autostart, async () => {
      const bundle = loadBundle()
      const { call } = fakeCall({
        'snapshot.fast': () => snapshotValue({ services: [service({ status, autostart })] }),
        'config.get': () => configValue('rev-1', autostart),
      })
      const tree = await mountAndSettle(bundle, call)
      const card = findByClass(tree.raw, 'svc-card')[0]
      assert.equal(findButton(card, '启动并').props.disabled, status === 'running' && autostart)
      assert.equal(findButton(card, '停止并').props.disabled, status === 'stopped' && !autostart)
      assert.equal(findButton(card, '重启（保留自动启动策略）').props.disabled, status === 'stopped')
      assert.ok(tree.text.includes('持久策略：自动启动已' + (autostart ? '启用' : '禁用')))
      assert.ok(tree.text.includes(status === 'running' ? '运行中' : '已停止'))
      assert.ok(tree.text.includes('启动会持久保存 autostart=true，停止会持久保存 autostart=false；重启保留策略'))
      assert.ok(tree.titles.includes('实际运行状态'))
      assert.ok(tree.dataAttrs.includes('data-autostart=' + autostart))
    })
  }
}

for (const [endpoint, label, autostart] of [
  ['start', '启动并', true], ['stop', '停止并', false], ['restart', '重启（保留', false],
]) {
  test(endpoint + ' success refreshes config raw/revision for the next form edit', async () => {
    const bundle = loadBundle()
    let changed = false
    const { call, calls } = fakeCall({
      'snapshot.fast': () => snapshotValue(),
      'config.get': () => configValue(changed ? 'rev-2' : 'rev-1', changed ? autostart : false),
      [endpoint]: () => {
        changed = true
        return snapshotValue({ revision: 4, services: [service({ autostart })] })
      },
      'config.upsert': () => configValue('rev-3', autostart),
      'snapshot.full': () => snapshotValue({ revision: 5 }),
    })
    const tree = await mountAndSettle(bundle, call)
    await clickAndSettle(tree, label)
    const updated = rerender(bundle, call)
    assert.ok(updated.text.includes('修订 rev-2'))
    const operation = calls.findIndex((entry) => entry.endpoint === endpoint)
    assert.equal(calls[operation + 1].endpoint, 'config.get')
    assert.deepEqual(Object.keys(calls[operation].payload), ['id'])
    await clickAndSettle(updated, '编辑配置')
    const form = rerender(bundle, call)
    await clickAndSettle(form, '保存到配置文件')
    const upsert = calls.find((entry) => entry.endpoint === 'config.upsert')
    assert.equal(upsert.payload.expectedRevision, 'rev-2')
    assert.equal(upsert.payload.service.autostart, autostart)
  })
}

for (const [endpoint, label, code, autostart] of [
  ['start', '启动并', 'PORT_OWNED_BY_OTHER', true],
  ['stop', '停止并', 'PORT_OWNED_BY_OTHER', false],
  ['restart', '重启（保留', 'OPERATION_FAILED', false],
]) {
  test(endpoint + ' failure keeps committed-policy notice and refreshes without force retry', async () => {
    let confirms = 0
    const bundle = loadBundle({ confirm: () => { confirms++; return true } })
    let failed = false
    const { call, calls } = fakeCall({
      'snapshot.fast': () => snapshotValue(),
      'config.get': () => configValue(failed ? 'rev-2' : 'rev-1', failed ? autostart : false),
      [endpoint]: () => {
        failed = true
        return { ok: false, error: { code, message: 'runtime action failed', details: {
          policyCommitted: true, autostart, configRevision: 'rev-2', pid: 123,
        } } }
      },
      'snapshot.full': () => snapshotValue({ revision: 4, services: [service({ autostart, status: 'stopped' })] }),
    })
    await clickAndSettle(await mountAndSettle(bundle, call), label)
    const tree = rerender(bundle, call)
    assert.equal(confirms, 0)
    assert.equal(calls.filter((entry) => entry.endpoint === endpoint).length, 1)
    assert.ok(calls.every((entry) => !('force' in entry.payload)))
    assert.ok(calls.some((entry) => entry.endpoint === 'snapshot.full'))
    assert.equal(calls.filter((entry) => entry.endpoint === 'config.get').length, 2)
    assert.ok(tree.text.includes('runtime action failed'))
    assert.ok(tree.text.includes('持久策略已保存：autostart=' + autostart))
    assert.ok(tree.text.includes('配置修订 rev-2'))
    assert.ok(tree.text.includes('本次运行操作未完成；策略不会自动回滚'))
    assert.ok(tree.text.includes('修订 rev-2'))
    assert.ok(tree.text.includes('已停止'))
    assert.ok(!tree.text.includes('强制重试'))
  })
}

test('failure refresh errors do not erase operation error or prevent config refresh', async () => {
  const bundle = loadBundle()
  const error = (message) => ({ ok: false, error: { code: 'OPERATION_FAILED', message, details: {} } })
  let configCalls = 0
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue(),
    'config.get': () => configValue('rev-' + ++configCalls),
    start: () => error('original action error'),
    'snapshot.full': () => error('snapshot refresh error'),
  })
  await clickAndSettle(await mountAndSettle(bundle, call), '启动并')
  const tree = rerender(bundle, call)
  assert.ok(tree.text.includes('original action error'))
  assert.ok(tree.text.includes('snapshot refresh error'))
  assert.ok(!tree.text.includes('持久策略已保存'))
  assert.ok(tree.text.includes('修订 rev-2'))
  assert.equal(calls.filter((entry) => entry.endpoint === 'start').length, 1)
})

for (const fails of [false, true]) {
  test('JSON draft retains original revision after policy refresh, failure=' + fails, async () => {
    const bundle = loadBundle()
    let changed = false
    const { call, calls } = fakeCall({
      'snapshot.fast': () => snapshotValue(),
      'config.get': () => configValue(changed ? 'rev-2' : 'rev-1', changed),
      start: () => {
        changed = true
        return fails
          ? { ok: false, error: { code: 'OPERATION_FAILED', message: 'failed', details: { policyCommitted: true, autostart: true, configRevision: 'rev-2' } } }
          : snapshotValue({ revision: 4, services: [service({ autostart: true })] })
      },
      'snapshot.full': () => snapshotValue({ revision: 4 }),
      'config.set': () => ({ ok: false, error: { code: 'CONFIG_CONFLICT', message: 'stale draft', details: {} } }),
    })
    let tree = await mountAndSettle(bundle, call)
    await clickAndSettle(tree, '高级：直接编辑 JSON')
    tree = rerender(bundle, call)
    const textarea = findByClass(tree.raw, 'svc-textarea')[0]
    assert.equal(textarea.props.value, configValue('rev-1').raw, 'first open must load actual raw, not blank')
    const draft = textarea.props.value + '\n'
    textarea.props.onChange({ target: { value: draft } })
    tree = rerender(bundle, call)
    await clickAndSettle(tree, '启动并')
    tree = rerender(bundle, call)
    assert.equal(findByClass(tree.raw, 'svc-textarea')[0].props.value, draft)
    assert.ok(tree.text.includes('JSON 草稿仍基于修订 rev-1；最新修订 rev-2'))
    await clickAndSettle(tree, '保存 JSON')
    const save = calls.find((entry) => entry.endpoint === 'config.set')
    assert.equal(save.payload.expectedRevision, 'rev-1')
    assert.equal(save.payload.raw, draft)
    tree = rerender(bundle, call)
    assert.ok(tree.text.includes('文件已被外部修改，请重新载入'))
    assert.equal(findByClass(tree.raw, 'svc-textarea')[0].props.value, draft)
    await clickAndSettle(tree, '重新载入')
    tree = rerender(bundle, call)
    assert.equal(findByClass(tree.raw, 'svc-textarea')[0].props.value, configValue('rev-2', true).raw)
    await clickAndSettle(tree, '保存 JSON')
    assert.equal(calls.filter((entry) => entry.endpoint === 'config.set').at(-1).payload.expectedRevision, 'rev-2')
  })
}

test('open form keeps its revision when service policy changes underneath it', async () => {
  const bundle = loadBundle()
  let changed = false
  const { call, calls } = fakeCall({
    'snapshot.fast': () => snapshotValue(),
    'config.get': () => configValue(changed ? 'rev-2' : 'rev-1', changed),
    start: () => { changed = true; return snapshotValue({ revision: 4, services: [service({ autostart: true })] }) },
    'config.upsert': () => ({ ok: false, error: { code: 'CONFIG_CONFLICT', message: 'stale form', details: {} } }),
  })
  await clickAndSettle(await mountAndSettle(bundle, call), '编辑配置')
  await clickAndSettle(rerender(bundle, call), '启动并')
  const tree = rerender(bundle, call)
  assert.ok(tree.text.includes('修订 rev-2'))
  await clickAndSettle(tree, '保存到配置文件')
  const save = calls.find((entry) => entry.endpoint === 'config.upsert')
  assert.equal(save.payload.expectedRevision, 'rev-1')
  assert.equal(save.payload.service.autostart, false)
  assert.ok(rerender(bundle, call).text.includes('stale form'))
})
