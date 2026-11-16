import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { canonicalNodeCommand } from '../src/identity.mjs'
import { createStaticServer, main } from '../src/static-server.mjs'

test('relative Node identity requires actual physical project cwd and stays inside it', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsm-relative-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  fs.mkdirSync(path.join(dir,'studio'));fs.writeFileSync(path.join(dir,'studio','entry.js'),'')
  const input='"D:/Program Files/nodejs/node.exe" studio/entry.js serve 8133'
  assert.ok(canonicalNodeCommand(input,dir,dir)?.includes(path.join(dir,'studio','entry.js')))
  assert.equal(canonicalNodeCommand(input,os.tmpdir(),dir),null)
  assert.equal(canonicalNodeCommand('node missing.js serve 8133',dir,dir),null)
  assert.equal(canonicalNodeCommand('node --eval "code"',dir,dir),null)
  assert.equal(canonicalNodeCommand('python studio/entry.js serve 8133',dir,dir),null)
  assert.equal(canonicalNodeCommand('node "'+path.join(dir,'studio','entry.js')+'" serve 8133',dir,dir),null)
})

test('static artifact server serves root/assets safely, never lists directories or escapes root', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsm-static-'))
  fs.writeFileSync(path.join(dir,'index.html'),'<h1>artifact</h1>')
  fs.writeFileSync(path.join(dir,'asset.js'),'const artifact=true;')
  fs.writeFileSync(path.join(dir,'.env'),'PRIVATE')
  fs.symlinkSync(path.join(os.tmpdir()),path.join(dir,'outside'),process.platform==='win32'?'junction':'dir')
  const server=createStaticServer({root:dir})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true})})
  const base='http://127.0.0.1:'+server.address().port
  assert.equal(await (await fetch(base+'/')).text(),'<h1>artifact</h1>')
  assert.match((await fetch(base+'/asset.js')).headers.get('content-type'),/javascript/)
  for(const route of ['/.env','/%2e%2e/secret','/outside/','/missing','/%5c..%5csecret']) assert.equal((await fetch(base+route)).status,404,route)
  assert.equal((await fetch(base+'/',{method:'POST'})).status,405)
  assert.equal((await fetch(base+'/',{method:'HEAD'})).status,200)
  const hostile=await new Promise(resolve=>{const req=http.get(base+'/',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',()=>resolve(null))})
  assert.equal(hostile,403)
  await assert.rejects(()=>main(['--root',dir,'--port','0']))
  await assert.rejects(()=>main(['--root',dir,'--port',String(server.address().port)]),error=>error.code==='EADDRINUSE')
})
