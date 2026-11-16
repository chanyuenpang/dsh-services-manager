import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../src/supervisor.mjs'
import { createAgentTool } from '../src/agent-tool.mjs'

function fixture(t, initialMode = 'danger-full-access') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-lifecycle-'))
  const configPath = path.join(dir, 'services.json')
  const listeners = new Map(), commands = new Map(), handles = [], kills = []
  const control = { mode: initialMode, healthy: true, prompts: 0 }
  const io = {
    listListeners: async () => control.list ? control.list() : new Map(listeners),
    commandLines: async (pids, options) => { assert.equal(options.fresh, true); if (control.query) await control.query(); return new Map(pids.map(pid => [pid, commands.get(pid) ?? ''])) },
    tcpProbe: async (_host, port) => listeners.has(port),
    waitForPortListening: async (port) => { if (control.wait) await control.wait(); return listeners.has(port) },
    waitForPortFree: async port => !listeners.has(port),
    httpProbe: async () => ({ healthy: control.healthy, status: control.healthy ? 200 : 500 }),
    processDirectory: async pid => control.directory ? control.directory(pid) : null,
    killTree: async pid => { kills.push(pid); for (const [port, owner] of listeners) if (owner === pid) listeners.delete(port) },
  }
  const manager = createManager({ configPath, stateDir: dir, logDir: dir, io, ctx: { subprocess: { spawn() {
    if (control.spawnError) throw Error('PRIVATE_SPAWN_ERROR')
    const pid = 1000 + handles.length
    listeners.set(4999, pid); commands.set(pid, 'node signed-entry.mjs --port 4999')
    let done
    const handle = { done: new Promise(resolve => { done = resolve }), terminate() { listeners.delete(4999); done({exitCode:0}) }, waitForExit: async () => true }
    handles.push(handle)
    return handle
  } } } })
  const session = { id: 'lifecycle-session' }
  const abort = new AbortController()
  const exec = { agent: { id: session.id, session }, callId: 'call', signal: abort.signal }
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: control.mode }) }, get: () => control.approvalMissing ? undefined : { request: async req => {
    control.prompts++; control.prompt = req.reason
    if (control.approve) return control.approve(req)
    return 'allowed-once'
  } } }
  const tool = createAgentTool(ctx, manager)
  const call = async args => {
    const value = await tool.execute(args, exec)
    assert.deepEqual(value, JSON.parse(JSON.stringify(value)), 'native output must be lossless JSON')
    return value
  }
  const service = { id: 'web', cwd: dir, command: 'node signed-entry.mjs --port 4999', port: 4999, match: { commandLinePattern: 'signed-entry[.]mjs --port 4999(?: +|$)' }, probe: { path: '/', expectStatus: 200 } }
  const revision = () => manager.agentDefinitions().configRevision
  const mutate = (action, extra = {}) => call({ action, ...(action === 'attach' ? { service } : { id: service.id }), expectedRevision: revision(), ...extra })
  t.after(async () => { await manager.dispose(); fs.rmSync(dir, {recursive:true, force:true}) })
  return { dir, configPath, manager, call, mutate, service, revision, tool, control, abort, listeners, commands, handles, kills }
}

test('native attach registers and starts once, supplies verified health, no HTTP token or browser', async t => {
  const f = fixture(t)
  const first = await f.mutate('attach')
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.value.registered, true); assert.equal(first.value.autostart, true)
  assert.equal(first.value.runtime.identityVerified, true); assert.equal(first.value.runtime.healthy, true)
  assert.equal(first.value.runtime.ownership, 'spawned')
  const again = await f.mutate('attach')
  assert.equal(again.value.status, 'already-running'); assert.equal(f.handles.length, 1)
  assert.equal(again.value.registrationChanged, false)
  const status = await f.call({ action: 'status', id: 'web' })
  assert.equal(status.value.status, 'running'); assert.equal(status.value.runtimeObserved, true)
  assert.ok(!JSON.stringify(status).includes('signed-entry'))
  assert.equal((await f.mutate('stop')).ok, true); assert.equal(f.listeners.size, 0)
  assert.equal(f.manager.agentDefinitions().services[0].autostart, false)
  assert.equal((await f.mutate('start')).ok, true); assert.equal(f.handles.length, 2)
  assert.equal((await f.mutate('restart')).ok, true); assert.equal(f.handles.length, 3)
  assert.equal(f.manager.agentDefinitions().services[0].autostart, true)
})

test('verified external instance is reused, conflict keeps fixed port without spawn, kill or raw leaks', async t => {
  for (const signed of [true, false]) {
    const f = fixture(t)
    f.listeners.set(4999, 88); f.commands.set(88, signed ? 'node signed-entry.mjs --port 4999' : 'PRIVATE_UNRELATED_COMMAND')
    const result = await f.mutate('attach')
    assert.equal(result.ok, signed, JSON.stringify(result))
    assert.equal(f.handles.length, 0); assert.equal(f.kills.length, 0)
    assert.equal(f.manager.agentDefinitions().services[0].port, 4999)
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
    if (signed) assert.equal(result.value.runtime.ownership, 'discovered')
    else {
      assert.equal(result.error.code, 'PORT_OWNED_BY_OTHER')
      assert.equal(result.error.details.policyCommitted, true); assert.equal(result.error.details.registered, true)
      const status = await f.call({action:'status',id:'web'})
      assert.equal(status.value.status, 'conflict'); assert.equal(status.value.identityVerified, false)
    }
  }
})

test('native lifecycle rejects stale CAS, unsupported fields, reserved host and contradictory attach policy', async t => {
  const f = fixture(t)
  const stale = f.revision()
  await f.mutate('attach')
  const denied = await f.call({action:'stop', id:'web', expectedRevision:stale})
  assert.equal(denied.error.code,'CONFIG_CONFLICT'); assert.equal(f.listeners.size,1)
  for (const input of [
    {action:'start',id:'web'}, {action:'stop',id:'dsh',expectedRevision:f.revision()},
    {action:'stop',id:'web',expectedRevision:f.revision(),force:true},
    {action:'attach',service:{...f.service,autostart:false},expectedRevision:f.revision()},
    {action:'attach',service:{...f.service,env:{TOKEN:'PRIVATE'}},expectedRevision:f.revision()},
  ]) assert.equal((await f.call(input)).error.code,'CONFIG_INVALID')
  assert.equal(f.handles.length,1)
  for (const action of ['attach','start','stop','restart','register']) assert.equal(f.tool.isConcurrencySafe({action}),false)
  for (const action of ['list','get','status']) assert.equal(f.tool.isConcurrencySafe({action}),true)
})

test('every native mutation uses session policy; status remains read-only and no missing config is seeded', async t => {
  const f = fixture(t,'read-only')
  assert.equal((await f.call({action:'status',id:'missing'})).error.code,'SERVICE_NOT_FOUND')
  assert.equal(fs.existsSync(f.configPath),false)
  for (const action of ['attach','start','stop','restart']) assert.equal((await f.mutate(action)).error.code,'PERMISSION_DENIED')
  assert.equal(f.handles.length,0); assert.equal(fs.existsSync(f.configPath),false)
  f.control.mode='workspace-write'; f.control.approvalMissing=true
  assert.equal((await f.mutate('attach')).error.code,'PERMISSION_DENIED')
  f.control.approvalMissing=false
  assert.equal((await f.mutate('attach')).ok,true)
  assert.equal(f.control.prompts,1); assert.match(f.control.prompt,/fixed port=4999/)
  await f.mutate('stop'); assert.equal(f.control.prompts,2)
})

test('permission loss, cancellation and config edits at async I/O cannot authorize late side effects', async t => {
  for (const kind of ['permission','cancel','config']) {
    const f = fixture(t)
    f.control.list = async () => {
      if (kind==='permission') f.control.mode='workspace-write'
      if (kind==='cancel') f.abort.abort()
      if (kind==='config') {
        const value=JSON.parse(fs.readFileSync(f.configPath,'utf8')); value.services[0].title='UI winner'; fs.writeFileSync(f.configPath,JSON.stringify(value))
      }
      return new Map()
    }
    const result = await f.mutate('attach')
    assert.equal(result.error.code,{permission:'PERMISSION_DENIED',cancel:'CANCELLED',config:'CONFIG_CONFLICT'}[kind],JSON.stringify(result))
    assert.equal(result.error.details.policyCommitted,true)
    assert.equal(f.handles.length,0); assert.equal(f.kills.length,0)
  }
})

test('spawn/health failures preserve registration and policy without claiming attach success', async t => {
  for (const kind of ['spawn','health']) {
    const f=fixture(t)
    if(kind==='spawn') f.control.spawnError=true
    else f.control.healthy=false
    const result=await f.mutate('attach')
    assert.equal(result.ok,false)
    assert.equal(result.error.code,kind==='spawn'?'OPERATION_FAILED':'HEALTH_CHECK_FAILED')
    assert.equal(result.error.details.registered,true); assert.equal(result.error.details.autostart,true)
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
    assert.equal(f.manager.agentDefinitions().services.length,1)
  }
})

test('status never confuses process query failure with a free port or starts a process', async t => {
  const f=fixture(t)
  await f.manager.agentRegister(f.service,f.revision())
  f.control.list=async()=>{throw Error('PRIVATE_QUERY_FAILURE')}
  const status=await f.call({action:'status',id:'web'})
  assert.equal(status.ok,true); assert.equal(status.value.status,'unknown')
  assert.equal(status.value.identityVerified,false); assert.equal(f.handles.length,0)
  assert.ok(!JSON.stringify(status).includes('PRIVATE_'))
})

test('restart keeps disabled policy; native queued commands recheck CAS after waiting', async t => {
  const f=fixture(t)
  await f.mutate('attach')
  await f.manager.agentRegister({id:'web',autostart:false},f.revision())
  const revision=f.revision()
  const restarting=f.call({action:'restart',id:'web',expectedRevision:revision})
  const stopping=f.call({action:'stop',id:'web',expectedRevision:revision})
  assert.equal((await restarting).ok,true)
  assert.equal((await stopping).ok,true)
  assert.equal(f.manager.agentDefinitions().services[0].autostart,false)
  assert.equal(f.listeners.size,0)
})
test('relative listener needs verified process cwd, then matches unchanged absolute signature', async t => {
  for(const correct of [true,false]) {
    const f=fixture(t)
    const entry=path.join(f.dir,'signed-entry.mjs');fs.writeFileSync(entry,'')
    f.service.command='node "'+entry+'" --port 4999'
    const escaped=Array.from(entry).map(c=>'\\.^$*+?()[]{}|'.includes(c)?'\\'+c:c).join('')
    f.service.match.commandLinePattern=escaped+'"? +--port +4999(?: +|$)'
    f.listeners.set(4999,88);f.commands.set(88,'node signed-entry.mjs --port 4999')
    f.control.directory=async pid=>({pid,commandLine:f.commands.get(pid),cwd:correct?f.dir:os.tmpdir()})
    const result=await f.mutate('attach')
    assert.equal(result.ok,correct,JSON.stringify(result))
    assert.equal(f.handles.length,0);assert.equal(f.kills.length,0)
  }
})

test('cancel after spawn reports committed partial effects, without rollback or duplicate start', async t => {
  const f=fixture(t)
  f.control.wait=async()=>f.abort.abort()
  const result=await f.mutate('attach')
  assert.equal(result.error.code,'CANCELLED')
  assert.equal(result.error.details.registered,true)
  assert.equal(result.error.details.policyCommitted,true)
  assert.equal(result.error.details.runtimeMayHaveChanged,true)
  assert.equal(f.handles.length,1)
  assert.equal(f.manager.agentDefinitions().services[0].autostart,true)
})

test('status refuses mixed revisions when UI edits during identity lookup', async t => {
  const f=fixture(t)
  await f.mutate('attach')
  f.control.query=async()=>{const raw=JSON.parse(fs.readFileSync(f.configPath,'utf8'));raw.services[0].title='concurrent UI';fs.writeFileSync(f.configPath,JSON.stringify(raw))}
  const result=await f.call({action:'status',id:'web'})
  assert.equal(result.error.code,'CONFIG_CONFLICT')
})

test('queued stale lifecycle revision cannot undo a prior policy commit', async t => {
  const f=fixture(t)
  await f.manager.agentRegister(f.service,f.revision())
  const revision=f.revision()
  const starting=f.call({action:'start',id:'web',expectedRevision:revision})
  const stopping=f.call({action:'stop',id:'web',expectedRevision:revision})
  assert.equal((await starting).ok,true)
  assert.equal((await stopping).error.code,'CONFIG_CONFLICT')
  assert.equal(f.listeners.size,1)
  assert.equal(f.manager.agentDefinitions().services[0].autostart,true)
})
