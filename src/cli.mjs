#!/usr/bin/env node
/** Dependency-free installed client. Never loads a manager or writes services.json. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateId, validateRegistration } from './registration.mjs'

const entry = fileURLToPath(import.meta.url)
export function help() {
  return `dsh-services — installed, authenticated local service client (Node >=20)
Resolved CLI: ${entry}
Package: ${path.dirname(path.dirname(entry))}
Equivalent entry: node "${entry}" --help
Profile installs may NOT add bins to PATH: use <profile>/node_modules/.bin/dsh-services
(Windows: dsh-services.cmd), or the absolute node entry above. No repository/skill needed.

Usage (options may appear before or after command):
  dsh-services --help                         Offline, no network/auth/config reads
  dsh-services list                           Runtime snapshot, including policy
  dsh-services get                            Definition raw JSON + revision
  dsh-services register --file service.json    Create/patch ONE stable id; no start
  dsh-services register --file -               Read JSON from stdin
  dsh-services start ID                       Persist autostart=true, then start
  dsh-services stop ID                        Persist autostart=false, then stop
  dsh-services restart ID                     Keep policy unchanged; never restart DSH
  dsh-services remove ID                      Remove definition only, does NOT stop

Connection (explicit user-selected running host; never token/profile discovery):
  --url http://127.0.0.1:3080 or DSH_SERVICES_URL (origin only, no token/query/path)
  Only literal 127.x.x.x / [::1], or localhost pinned to 127.0.0.1; http or https.
  DSH_SERVICES_TOKEN environment variable OR --token-stdin (first stdin line).
  Ask the user for their authorized DSH access URL from the browser/host launch output.
  Split its origin and token privately; DO NOT put token in argv, chat, logs or a URL option.
  CLI exchanges token via GET /?token=... -> 303 cookie -> POST /dsh-services/<method>.
  Redirects are NEVER followed; cookie stays in memory on this origin only.
  --token-stdin + --file -: first line token, remaining stdin JSON. Input requires EOF.
  Prefer a protected pipe/secret source. Environment is convenient, not a secret vault.
  The host necessarily receives the token URL: keep host/access logs private.
  This uses existing full host authorization, NOT an agent permission sandbox.
  Host must already have this plugin installed/loaded. Offline or unauthenticated => fail;
  never starts a second manager, opens an unprotected port or edits services.json locally.

Register JSON (UTF-8 file; optional BOM; paths below are examples, replace them):
  {"id":"my-api","cwd":"C:/Services/My API","command":"node server.mjs",
   "port":4590,"match":{"commandLinePattern":"server[.]mjs"}}
  id: required exact stable [a-zA-Z0-9][a-zA-Z0-9._-]*; dsh reserved.
      No slugify/trimming/truncation; repeats update same id, never make duplicates.
  cwd + command: required on create; use an absolute host cwd, quote paths with spaces
      inside command. No pipes/redirection/&&; put multi-step work in a script.
  port: required on create, integer 1..65535; no port inference or clearing here.
      Legacy no-port definitions may show dispatched, NOT verified network readiness.
  match.commandLinePattern: required on create, non-empty regex identifying the actual
      listener command line. Cannot clear it; mismatch never authorizes termination.
  Optional: title, host, url, autostart (default false), autoStopOnExit (default true),
      env (string map), probe {path,expectStatus,intervalMs}, takeover:"match",
      restartMode:"inline". Unknown fields/types rejected by CLI AND host.
  Existing id: overwrite ONLY explicit fields; omitted fields and nested keys preserved.
      env/match/probe merge keys; null probe.path clears probe path. Core fields cannot clear.
  New install defaults to empty definitions; existing user services.json is untouched.
  Register never starts a process, even if autostart:true; that selects next-load recovery.

Concurrency and persistent intent:
  register/remove first get current revision, then submit expectedRevision atomically on host.
  Optional --revision REV on register/remove pins a previously reviewed get revision.
  CONFIG_CONFLICT (exit 5): run get, compare current definition + revision, review changes,
      then resubmit same stable id with --revision NEW_REV. NO automatic overwrite/retry.
  Config with bad entries is rejected intact; repair through the existing config editor.
  start/stop commit policy BEFORE I/O, including already running/stopped services.
  If execution fails, details.policyCommitted/autostart/configRevision describe saved intent;
      failure does not roll back policy. stop can leave a mismatched listener still running.
  Plugin reload recovers true only; stop disables future recovery; restart keeps prior policy.
  Dispose/natural exits don't change policy; autoStopOnExit covers only plugin-owned processes.
  On timeout/disconnect, run get + list before retry: write may already have committed.
  One selected host owns writes per home; revision+rename is NOT a cross-process transaction.

Examples (PowerShell, token supplied privately, never hardcoded here):
  $env:DSH_SERVICES_URL = 'http://127.0.0.1:3080'
  Get-Content -Raw ./service.json | dsh-services register --file -
  dsh-services start my-api
  dsh-services stop my-api
  dsh-services get
  Get-Content -Raw C:/Private/dsh-token.txt | dsh-services list --token-stdin
  # Above token file must already be privately provisioned and access-restricted.
  dsh-services register --file ./service.json --revision REVIEWED_REVISION
  Remove-Item Env:DSH_SERVICES_TOKEN  # after use

Machine output: one JSON envelope on stdout (success) or stderr (failure).
  {"ok":true,"value":{"id":"my-api","configRevision":"..."}}
  {"ok":false,"error":{"code":"CONFIG_CONFLICT","message":"...","details":{}}}
Exit codes: 0 success/help; 2 usage/input/config-invalid; 3 authentication;
  4 connection/HTTP/protocol/timeout; 5 revision conflict; 6 host operation failure.
Example: inspect $LASTEXITCODE after register; 5 means review get, NOT blind retry.
`
}

function failure(code, message, exitCode, details = {}) {
  return Object.assign(new Error(message), { code, exitCode, details })
}
export function localOrigin(value) {
  // Validate the original spelling before URL normalization (reject integer/octal IPs,
  // credentials, backslashes, encoded hosts, paths, fragments and query secrets).
  if (typeof value !== 'string' || !/^https?:\/\/(?:127(?:\.(?:0|[1-9][0-9]{0,2})){3}|\[::1\]|localhost)(?::[0-9]+)?\/?$/.test(value))
    throw failure('USAGE', 'Use an explicit loopback origin without credentials, path, query or fragment.', 2)
  let url
  try { url = new URL(value) } catch { throw failure('USAGE', 'Invalid loopback URL.', 2) }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1' // no DNS resolution/rebinding
  if (url.hostname !== '[::1]' && !/^127\./.test(url.hostname)) throw failure('USAGE', 'Invalid loopback address.', 2)
  return url.origin
}

function parseArgs(argv, env) {
  const options = { url: env.DSH_SERVICES_URL }
  const positional = []
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    if (!['--url', '--file', '--revision', '--token-stdin'].includes(arg) || seen.has(arg)) throw failure('USAGE', 'Unknown or duplicate option; see --help.', 2)
    seen.add(arg)
    if (arg === '--token-stdin') options.tokenStdin = true
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw failure('USAGE', 'Missing option value; see --help.', 2)
      options[arg.slice(2)] = argv[++i]
    }
  }
  const [command, id] = positional
  if (!['list', 'get', 'register', 'start', 'stop', 'restart', 'remove'].includes(command)) throw failure('USAGE', 'Unknown command; see --help.', 2)
  const needsId = ['start', 'stop', 'restart', 'remove'].includes(command)
  if (positional.length !== (needsId ? 2 : 1)) throw failure('USAGE', 'Wrong command arguments; see --help.', 2)
  if (needsId) validateId(id)
  if ((command === 'register') !== ('file' in options)) throw failure('USAGE', '--file is required only for register.', 2)
  if ('revision' in options && !['register', 'remove'].includes(command)) throw failure('USAGE', '--revision is only for register/remove.', 2)
  return { ...options, command, id, origin: localOrigin(options.url) }
}

async function readStdin(stream) {
  if (stream.isTTY) throw failure('USAGE', 'Provide stdin through a protected pipe, then EOF.', 2)
  let text = ''
  stream.setEncoding?.('utf8')
  for await (const chunk of stream) {
    text += chunk.toString()
    if (text.length > 1024 * 1024) throw failure('USAGE', 'stdin exceeds 1 MiB.', 2)
  }
  return text
}

export async function runCli(argv = process.argv.slice(2), { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, fetchImpl = fetch } = {}) {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') { stdout.write(help()); return 0 }
  const secrets = []
  const redact = (text) => {
    let result = text
    for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]')
    return result
  }
  const output = (value) => redact(JSON.stringify(value, (_key, v) => typeof v === 'string' ? redact(v) : v)) + '\n'
  try {
    const options = parseArgs(argv, env)
    let input = options.tokenStdin || options.file === '-' ? await readStdin(stdin) : ''
    let token = env.DSH_SERVICES_TOKEN
    if (options.tokenStdin) {
      const newline = input.indexOf('\n')
      token = (newline < 0 ? input : input.slice(0, newline)).replace(/\r$/, '')
      input = newline < 0 ? '' : input.slice(newline + 1)
    }
    if (typeof token !== 'string' || !token || /\s/.test(token) || token.length > 8192) throw failure('AUTH', 'Supply DSH_SERVICES_TOKEN or --token-stdin; see --help.', 3)
    secrets.push(token, encodeURIComponent(token))
    let service
    if (options.command === 'register') {
      try {
        const text = options.file === '-' ? input : await fs.readFile(options.file, 'utf8')
        service = JSON.parse(text.replace(/^\uFEFF/, ''))
      } catch { throw failure('USAGE', 'Cannot read UTF-8 service JSON; see --help.', 2) }
      validateRegistration(service)
    }
    async function request(url, init) {
      try { return await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) }) }
      catch { throw failure('CONNECTION', 'Host unavailable or request timed out. Read get/list before retrying writes.', 4) }
    }
    const exchange = await request(options.origin + '/?token=' + encodeURIComponent(token), {})
    const cookies = typeof exchange.headers.getSetCookie === 'function' ? exchange.headers.getSetCookie() : [exchange.headers.get('set-cookie')]
    const cookie = cookies.filter(Boolean).map((s) => s.split(';')[0]).join('; ')
    await exchange.body?.cancel()
    if (exchange.status !== 303 || !cookie) throw failure('AUTH', 'Authentication failed: expected DSH token-to-cookie exchange.', 3)
    secrets.push(cookie, ...cookie.split('; ').map((s) => s.slice(s.indexOf('=') + 1)))
    async function rpc(endpoint, payload = {}) {
      const response = await request(options.origin + '/dsh-services/' + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: 'cli-' + randomUUID(), method: endpoint, payload }),
      })
      if (response.status !== 200) {
        await response.body?.cancel()
        throw failure(response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP', 'Host rejected RPC (HTTP ' + response.status + '); redirects are not followed.', response.status === 401 || response.status === 403 ? 3 : 4)
      }
      let message
      try { message = await response.json() } catch { throw failure('PROTOCOL', 'Invalid RPC JSON response.', 4) }
      const result = message?.result
      if (message?.type !== 'server-response' || !result || typeof result.ok !== 'boolean') throw failure('PROTOCOL', 'Invalid RPC envelope.', 4)
      if (result.ok === false) {
        if (typeof result.error?.code !== 'string' || typeof result.error?.message !== 'string' || !result.error?.details || typeof result.error.details !== 'object') throw failure('PROTOCOL', 'Invalid RPC error envelope.', 4)
        const { code, message: text, details } = result.error
        throw failure(code, text, code === 'CONFIG_CONFLICT' ? 5 : code === 'CONFIG_INVALID' ? 2 : 6, details)
      }
      if (!Object.hasOwn(result, 'value')) throw failure('PROTOCOL', 'RPC success missing value.', 4)
      return result.value
    }
    let value
    if (options.command === 'register' || options.command === 'remove') {
      const expectedRevision = options.revision ?? (await rpc('config.get')).revision
      if (typeof expectedRevision !== 'string' || !expectedRevision) throw failure('PROTOCOL', 'Missing config revision.', 4)
      value = await rpc(options.command === 'register' ? 'config.upsert' : 'config.remove', options.command === 'register' ? { service, registration: true, expectedRevision } : { id: options.id, expectedRevision })
    } else value = await rpc(({ list: 'snapshot', get: 'config.get' })[options.command] ?? options.command, options.id ? { id: options.id } : {})
    stdout.write(output({ ok: true, value }))
    return 0
  } catch (error) {
    const exitCode = error.exitCode ?? (error.code === 'CONFIG_INVALID' ? 2 : 4)
    stderr.write(output({ ok: false, error: { code: error.code ?? 'CLIENT_ERROR', message: error.exitCode || error.code === 'CONFIG_INVALID' ? error.message : 'Client failed; see --help. No automatic retry was attempted.', details: error.details ?? {} } }))
    return exitCode
  }
}

// Resolve npm's symlink entry on POSIX too; importing this module never executes it.
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === entry) process.exitCode = await runCli()
