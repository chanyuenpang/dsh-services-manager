/** Launcher behavior contracts; real UI is additionally exercised in an isolated DSH. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture({ browser = true, call = async () => ({ ok: true, value: { services: [] } }) } = {}) {
  let definition, component, injected, tabType
  let index = 0, effects = []
  const states = [], opens = [], externals = [], timers = new Map(), listeners = new Map(), resources = []
  let nextTimer = 0
  let refresh
  const tab = {
    visible: true, signal: new AbortController().signal,
    actions: {
      openTab: (...args) => opens.push(args),
      bindCommands: commands => { refresh = commands.refresh; return () => { refresh = undefined } },
    },
  }
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) },
  }
  const window = { location: { origin: 'http://127.0.0.1:14163' }, open: (...args) => externals.push(args), __ModuleLoader__: { load: value => { definition = value } } }
  const context = vm.createContext({ window, document, URL, console,
    setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer }, clearInterval: id => timers.delete(id),
  })
  vm.runInContext(source, context)
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false) }),
    useState: initial => { const n = index++; if (!(n in states)) states[n] = initial; return [states[n], v => { states[n] = typeof v === 'function' ? v(states[n]) : v }] },
    useRef: initial => { const n = index++; if (!(n in states)) states[n] = { current: initial }; return states[n] },
    useEffect: fn => effects.push(fn),
  }
  const plugin = definition.factory(name => { assert.equal(name, 'react'); return React })
  const locale = { bind: () => key => key, register: () => () => {} }
  const slots = { inject: (_, fn) => fn(), register: (spec, target) => {
    if (spec.key === 'dsh-services-manager/web') { component = target; injected = spec.inject() }
    return () => {}
  } }
  const scope = {
    locale, slots, sidebarRightTabs: { register: spec => { tabType = spec; return () => {} }, get: () => browser ? {} : undefined },
    effect: fn => { const dispose = fn(); resources.push(dispose); return dispose },
  }
  plugin.apply({ slots, connection: { rpc: { call: (_, endpoint, payload) => call(endpoint, payload) } }, inject: (_, fn) => fn(scope) })
  const render = () => { index = 0; effects = []; return component({ ...injected, t: key => key, useTabInfo: () => ({ tab }) }) }
  return {
    render, tab, document, timers, listeners, opens, externals, resources,
    type: () => tabType,
    start: () => effects.map(fn => fn()),
    refresh: () => refresh(),
    poll: async () => { for (const fn of timers.values()) fn(); await tick(); await tick() },
    setExternal: fn => { window.open = fn },
  }
}
function walk(node, predicate, results = []) {
  if (node && typeof node === 'object') { if (predicate(node)) results.push(node); for (const c of node.children || []) walk(c, predicate, results) }
  return results
}
const buttons = tree => walk(tree, n => n.type === 'button')
const rows = tree => walk(tree, n => n.props?.className === 'svc-launch__row')
const text = node => typeof node === 'object' ? (node?.children || []).map(text).join(' ') : String(node)
const value = services => ({ ok: true, value: { services } })
const service = (extra = {}) => ({ id: 'demo', title: 'Demo', status: 'running', managed: true, url: 'http://127.0.0.1:4599/a?q=1#x', ...extra })

async function mount(f) { f.render(); const dispose = f.start(); await tick(); await tick(); return dispose }

test('contributes a unique guide entry after browser and registers disposable resources', () => {
  const f = fixture()
  const type = f.type()
  assert.equal(type.kind, 'dsh-services-web')
  assert.equal(type.id, 'dsh-services-manager/web')
  assert.equal(type.guide[0].order, 31)
  assert.ok(f.resources.every(d => typeof d === 'function'))
})

test('only running HTTP(S) services appear; no DSH, credentials, executable URLs or other states', async () => {
  const f = fixture({ call: async () => value([
    service(), service({ id: 'stopped', status: 'stopped' }), service({ id: 'unknown', status: 'unknown' }),
    service({ id: 'starting', status: 'starting' }), service({ id: 'error', status: 'error' }),
    service({ id: 'dsh' }), service({ id: 'unmanaged', managed: false }),
    ...['javascript:alert(1)', 'file:///C:/file', 'data:text/html,test', 'http://user:pass@localhost:9000', 'http://127.0.0.1:14163/', '', null, 'not-a-url'].map((url, i) => service({ id: 'unsafe-' + i, url })),
  ]) })
  await mount(f)
  const tree = f.render()
  assert.equal(rows(tree).length, 1)
  assert.equal(buttons(tree).length, 2)
  assert.ok(text(tree).includes('Demo'))
  for (const b of buttons(tree)) { assert.equal(text(b).trim(), ''); assert.ok(b.props.title); assert.ok(b.props['aria-label'].includes('Demo')) }
  assert.ok(!text(tree).includes('4599'))
})

test('two icon actions use session-bound browser open and native external policy without any mutation RPC', async () => {
  const calls = []
  const f = fixture({ call: async (endpoint, payload) => { calls.push(endpoint); return value([service()]) } })
  await mount(f)
  const [inside, outside] = buttons(f.render())
  inside.props.onClick(); outside.props.onClick()
  assert.equal(f.opens.length, 1)
  assert.equal(f.opens[0][0], 'browser')
  assert.equal(f.opens[0][1].params.url, service().url)
  assert.deepEqual(f.externals[0], [service().url, '_blank', 'noopener,noreferrer'])
  assert.deepEqual(calls, ['snapshot.fast'])
})

test('missing browser disables only internal action; external remains available', async () => {
  const f = fixture({ browser: false, call: async () => value([service()]) })
  await mount(f)
  const [inside, outside] = buttons(f.render())
  assert.equal(inside.props.disabled, true)
  assert.equal(inside.props.title, 'browserMissing')
  assert.equal(outside.props.disabled, false)
})

test('no poll for hidden tab; hidden document pauses reads; cleanup ignores late responses', async () => {
  let calls = 0, resolve
  const f = fixture({ call: () => { calls++; return new Promise(r => { resolve = r }) } })
  f.render(); const dispose = f.start()
  assert.equal(calls, 1)
  await f.poll(); assert.equal(calls, 1, 'requests must never overlap')
  for (const fn of dispose) fn()
  assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0)
  resolve(value([service()]))
  await tick()
  assert.equal(rows(f.render()).length, 0, 'late result must not write after disposal')
  const hidden = fixture({ call: async () => { calls++; return value([]) } })
  hidden.tab.visible = false; await mount(hidden)
  assert.equal(calls, 1); assert.equal(hidden.timers.size, 0)
  const documentHidden = fixture({ call: async () => { calls++; return value([]) } })
  documentHidden.document.visibilityState = 'hidden'; await mount(documentHidden); await documentHidden.poll()
  assert.equal(calls, 1)
})

test('cache miss waits for full snapshot, errors have icon retry and clear stale rows', async () => {
  const calls = []; let fail = false
  const f = fixture({ call: async endpoint => {
    calls.push(endpoint)
    if (fail) throw Error('transport')
    if (endpoint === 'snapshot.fast') return { ok: true, value: { services: [], timing: { cacheMiss: true } } }
    return value([service()])
  } })
  const initial = f.render(); assert.equal(walk(initial, n => n.props?.role === 'status').length, 1)
  await mount(f)
  assert.deepEqual(calls, ['snapshot.fast', 'snapshot.full'])
  assert.equal(rows(f.render()).length, 1)
  fail = true; await f.poll()
  const failed = f.render()
  assert.equal(rows(failed).length, 0); assert.equal(buttons(failed).length, 1)
  assert.equal(buttons(failed)[0].props.title, 'retry')
  fail = false; buttons(failed)[0].props.onClick(); await tick()
  assert.equal(rows(f.render()).length, 1)
})

test('detail-layer refresh never delays a launcher that only needs the fast name/status layer', async () => {
  const calls = []
  const f = fixture({ call: async endpoint => {
    calls.push(endpoint)
    return { ok: true, value: { services: [service()], timing: { degraded: true, refreshing: true, cacheMiss: false } } }
  } })
  await mount(f)
  assert.deepEqual(calls, ['snapshot.fast'])
  assert.equal(rows(f.render()).length, 1)
})

test('stopping a service removes it next poll; empty state has no management button', async () => {
  let status = 'running'
  const f = fixture({ call: async () => value([service({ status })]) })
  await mount(f); assert.equal(rows(f.render()).length, 1)
  status = 'stopped'; await f.poll()
  const empty = f.render(); assert.equal(rows(empty).length, 0); assert.equal(buttons(empty).length, 0)
  assert.ok(text(empty).includes('empty'))
  status = 'running'; f.refresh(); await tick(); assert.equal(rows(f.render()).length, 1)
})

test('open failures are visible and ended tabs cannot navigate', async () => {
  const f = fixture({ call: async () => value([service()]) })
  await mount(f); f.setExternal(() => { throw Error('denied') })
  buttons(f.render())[1].props.onClick()
  assert.ok(text(f.render()).includes('openFailed'))
  f.tab.visible = false; buttons(f.render())[0].props.onClick(); assert.equal(f.opens.length, 0)
})
