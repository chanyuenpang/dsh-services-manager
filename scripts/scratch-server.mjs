/**
 * 验证用的临时 HTTP 服务：监听给定端口，打印一行就绪标记。
 * 由 scripts/verify-host.mjs 以「真实命令」的形式启动，用来验证 start/stop 链路。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 4599)
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(`scratch-ok ${request.url}\n`)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`scratch-server listening on 127.0.0.1:${port} (pid ${process.pid})`)
})
