#!/usr/bin/env node
/** Dependency-free, fixed-port loopback hosting for a generated static Web artifact. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.ico':'image/x-icon', '.wasm':'application/wasm', '.woff2':'font/woff2', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.mp4':'video/mp4', '.pdf':'application/pdf' }
export function createStaticServer({root, entry='index.html'}) {
  if (!path.isAbsolute(root)) throw Error('Static root must be an absolute directory')
  root=fs.realpathSync(root)
  if(!fs.statSync(root).isDirectory()) throw Error('Static root must be a directory')
  const inside = file => file.startsWith(root+path.sep)
  const entryFile=fs.realpathSync(path.resolve(root,entry))
  if(!inside(entryFile) || !fs.statSync(entryFile).isFile()) throw Error('Static entry must be a file inside the root')
  const server=http.createServer((req,res)=>{
    const reply=status=>{res.writeHead(status,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end()}
    if(!['GET','HEAD'].includes(req.method)) return reply(405)
    const port=server.address()?.port
    if(![ '127.0.0.1:'+port, 'localhost:'+port ].includes(req.headers.host)) return reply(403)
    try {
      const raw=decodeURIComponent((req.url??'/').split('?')[0])
      if(raw.includes('\\') || raw.includes('\0') || raw.split('/').some(segment=>segment.startsWith('.'))) return reply(404)
      const file=raw==='/'?entryFile:fs.realpathSync(path.resolve(root,'.'+raw))
      if(!inside(file) || !fs.statSync(file).isFile()) return reply(404)
      res.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()]??'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'})
      if(req.method==='HEAD') return res.end()
      const stream=fs.createReadStream(file)
      stream.on('error',()=>res.destroy())
      stream.pipe(res)
    } catch {reply(404)}
  })
  return server
}
export async function main(argv=process.argv.slice(2)) {
  const options={}
  for(let i=0;i<argv.length;i+=2) {
    if(!['--root','--port','--entry'].includes(argv[i]) || !argv[i+1] || options[argv[i].slice(2)]!==undefined) throw Error('Usage: static-server.mjs --root <absolute artifact directory> --port <fixed port> [--entry index.html]')
    options[argv[i].slice(2)]=argv[i+1]
  }
  const port=Number(options.port)
  if(!Number.isInteger(port)||port<1||port>65535) throw Error('A fixed port in 1..65535 is required; automatic port fallback is forbidden')
  const server=createStaticServer(options)
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
  console.log('Static artifact listening on http://127.0.0.1:'+port+'/')
  return server
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.code==='EADDRINUSE'?'Configured port is already in use; no port fallback performed':error.message);process.exitCode=1})
