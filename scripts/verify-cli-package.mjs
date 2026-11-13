/** Offline tarball gate: installed CLI entry/bin from unrelated cwd (including spaces).
 * No DSH instance is started. The local HTTP tests use a test-only authenticated server.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm package offline '))
const installed = path.join(temp, 'clean installation')
const unrelated = path.join(temp, 'not a repository')
fs.mkdirSync(installed); fs.mkdirSync(unrelated)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const quoted = (value) => process.platform === 'win32' ? '"' + value + '"' : value
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true })
  if (result.error) throw result.error
  assert.equal(result.status, 0, command + ' failed')
}
try {
  run(npm, ['pack', '--offline', '--ignore-scripts', '--pack-destination', quoted(temp)], root)
  const tarballs = fs.readdirSync(temp).filter((f) => f.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ private: true }))
  run(npm, ['install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', quoted(path.join(temp, tarballs[0]))], installed)
  const entry = path.join(installed, 'node_modules', 'dsh-services-manager', 'src', 'cli.mjs')
  assert.ok(fs.existsSync(entry))
  const env = { ...process.env }
  delete env.DSH_SERVICES_URL; delete env.DSH_SERVICES_TOKEN
  // Neither call references the repository; no credentials/network required for --help.
  run(quoted(process.execPath), [quoted(entry), '--help'], unrelated, env)
  const bin = path.join(installed, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh-services.cmd' : 'dsh-services')
  assert.ok(fs.existsSync(bin))
  run(quoted(bin), ['--help'], unrelated, env)
  // Exercise the installed CLIENT over real loopback HTTP; the host fixture remains test-only.
  run(quoted(process.execPath), ['--test', quoted(path.join(root, 'test', 'cli.test.mjs'))], unrelated, { ...env, DSH_TEST_CLI_ENTRY: entry })
  console.log('PASS: offline tarball + installed direct/bin help + installed client HTTP tests; no DSH launched')
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
