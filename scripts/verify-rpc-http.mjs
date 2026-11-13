/**
 * 真机 HTTP 层 RPC 验证：拿 token URL 换 cookie，逐个打 `/dsh-services/<endpoint>`。
 *
 * 为什么必须有这一层：宿主发给浏览器的**信封字段**（`value` 而不是 `data`）只在这条真实传输上生效 ——
 * 传输层按 schema 校验响应会剥掉未知键，所以用 fake seam 或直接调 handler 都验证不到它。
 * 之前的 bug 正是：宿主发 `{ok:true,data}` → 浏览器只收到 `{ok:true}` → 面板报 TypeError。
 *
 * 用法：
 *   node scripts/verify-rpc-http.mjs "http://127.0.0.1:3080/?token=..."
 *   （token URL 在 `<DSH_HOME>/.dsh-services-manager/logs/dsh-web.log` 最后一行，或浏览器地址栏）
 *
 * 只读：snapshot / config.get / 一个不存在的端点（验错误信封）。
 * **故意不碰 `restart-dsh`** —— 那会真的安排一次重启；要验调度请用长 grace 并立刻杀掉看守进程。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Read only this explicitly selected sandbox's private log; never print its token.
const target = process.argv[2] === '--log'
  ? fs.readFileSync(process.argv[3], 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+/g)?.at(-1)
  : process.argv[2]
if (typeof target !== 'string' || target === '') {
  console.error('用法: node scripts/verify-rpc-http.mjs "http://127.0.0.1:<port>/?token=..."')
  process.exit(2)
}

const origin = new URL(target).origin
const record = (step, data) => console.log(`[${step}] ${JSON.stringify(data)}`)

// 1) token → 会话 cookie（303 + set-cookie）
const exchange = await fetch(target, { redirect: 'manual' })
const rawCookie = typeof exchange.headers.getSetCookie === 'function'
  ? exchange.headers.getSetCookie()[0]
  : exchange.headers.get('set-cookie')
assert.equal(exchange.status, 303, `token 交换必须返回 303，实际 ${exchange.status}`)
assert.ok(typeof rawCookie === 'string' && rawCookie.length > 0, 'token 交换没有返回 set-cookie')
const cookie = rawCookie.split(';')[0]
record('auth', { origin, status: exchange.status, cookieName: cookie.split('=')[0] })

// 1.5) Authenticated application index must contain this plugin in its boot roster.
const indexResponse = await fetch(`${origin}/`, { headers: { cookie }, redirect: 'manual' })
assert.equal(indexResponse.status, 200, 'authenticated index must load')
const html = await indexResponse.text()
const bootScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]).find((script) => script.includes('__DSH_BOOT__'))
assert.ok(bootScript?.includes('dsh-services-manager'), 'client boot roster must include dsh-services-manager')
record('client-roster', { status: indexResponse.status, plugin: 'dsh-services-manager', present: true })

async function rpc(endpoint, payload = {}) {
  const response = await fetch(`${origin}/dsh-services/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `probe-${endpoint}-${Date.now()}`,
      method: endpoint,
      payload,
    }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, `${endpoint} 期望 HTTP 200，实际 ${response.status}：${text.slice(0, 200)}`)
  const message = JSON.parse(text)
  assert.equal(message.type, 'server-response', `${endpoint} 响应不是 server-response`)
  return message.result
}

// 2) snapshot：成功信封必须是 { ok: true, value } —— 这一条就是回归闸门
const snapshot = await rpc('snapshot')
assert.equal(snapshot.ok, true, `snapshot 失败：${JSON.stringify(snapshot.error ?? {})}`)
assert.notEqual(snapshot.value, undefined, 'snapshot 成功信封缺少 value（信封字段不匹配）')
assert.ok(Array.isArray(snapshot.value.services), 'snapshot.value.services 必须是数组')
record('snapshot', {
  revision: snapshot.value.revision,
  summary: snapshot.value.summary,
  services: snapshot.value.services.map((service) => ({
    id: service.id, port: service.port, status: service.status, ownership: service.ownership, pid: service.pid,
  })),
})

// 3) 快层：首屏路径必须是毫秒级，且带新鲜度语义（timing 由宿主计算，客户端只投影）
const fastStarted = Date.now()
const fast = await rpc('snapshot.fast')
const fastMs = Date.now() - fastStarted
assert.equal(fast.ok, true, `snapshot.fast 失败：${JSON.stringify(fast.error ?? {})}`)
const timing = fast.value.timing
assert.ok(timing !== null && typeof timing === 'object', 'snapshot.fast 必须带 timing')
assert.equal(typeof timing.collectedAt, 'number', 'timing.collectedAt 必须是数字')
assert.equal(typeof timing.ageMs, 'number', 'timing.ageMs 必须是数字')
assert.ok(timing.tier === 1 || timing.tier === 2, 'timing.tier 必须是 1 或 2')
assert.equal(typeof timing.returnedFromCache, 'boolean', 'timing.returnedFromCache 必须是布尔')
assert.equal(typeof timing.refreshing, 'boolean', 'timing.refreshing 必须是布尔')
assert.equal(typeof timing.degraded, 'boolean', 'timing.degraded 必须是布尔')
assert.equal(typeof timing.cacheMiss, 'boolean', 'timing.cacheMiss 必须是布尔')
assert.ok(Array.isArray(fast.value.services), 'snapshot.fast.services 必须是数组')
record('snapshot.fast', {
  elapsedMs: fastMs,
  returnedFromCache: timing.returnedFromCache,
  tier: timing.tier,
  degraded: timing.degraded,
  refreshing: timing.refreshing,
  ageMs: timing.ageMs,
  pids: fast.value.services.map((service) => `${service.id}:${service.pid ?? '-'}`),
})

// 4) config.get：唯一真相文件的原文与 revision
const config = await rpc('config.get', {})
assert.equal(config.ok, true)
assert.equal(typeof config.value.raw, 'string', 'config.get.value.raw 必须是字符串')
assert.equal(typeof config.value.revision, 'string', 'config.get.value.revision 必须是字符串')
record('config.get', { path: config.value.path, revision: config.value.revision, bytes: config.value.raw.length })

// 4) 不存在的端点：错误信封必须是 { ok:false, error:{ code, message, details:{} } }
const failure = await rpc('__probe_unknown_endpoint__', {})
assert.equal(failure.ok, false, '未知端点必须返回失败信封')
assert.equal(typeof failure.error.code, 'string')
assert.equal(typeof failure.error.message, 'string')
assert.equal(typeof failure.error.details, 'object', 'details 必须是对象（schema 必填）')
record('error-envelope', { code: failure.error.code, details: failure.error.details })

console.log('PASS')
