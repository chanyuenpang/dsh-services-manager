#!/usr/bin/env node
/** Offline discovery of the selected profile only. Never reads credentials or changes state. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export function resolveCli({ env = process.env, profileDir } = {}) {
  const selected = profileDir || env.DSH_PROFILE_DIR
  let directory
  if (selected) {
    if (!path.isAbsolute(selected)) throw new Error('Profile directory must be absolute')
    directory = path.resolve(selected)
  } else {
    const profile = env.DSH_PROFILE
    if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) {
      throw new Error('No selected profile: provide DSH_PROFILE_DIR or --profile-dir; do not scan other profiles')
    }
    const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
    if (!path.isAbsolute(home)) throw new Error('DSH_HOME must be absolute')
    directory = path.join(home, 'profiles', profile)
  }
  const packageDir = path.join(directory, 'node_modules', 'dsh-services-manager')
  const cli = path.join(packageDir, 'src', 'cli.mjs')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    if (!fs.statSync(cli).isFile()) throw new Error('CLI is not a file')
  } catch {
    throw new Error('dsh-services-manager CLI is not installed in the selected profile; do not launch a second manager')
  }
  if (manifest.name !== 'dsh-services-manager') throw new Error('Unexpected package at selected CLI location')
  let origin = null
  const rawUrl = env.DSH_SERVICES_URL || env.DSH_WEB_URL
  if (rawUrl) {
    // Reject nonliteral spellings before URL canonicalization (integer/octal/hex IPs).
    if (!/^https?:\/\/(?:localhost|\[::1\]|127(?:\.(?:0|[1-9][0-9]{0,2})){3})(?::[0-9]+)?(?:[/?#]|$)/.test(rawUrl)) {
      throw new Error('Selected host must use a literal loopback HTTP(S) address')
    }
    if (env.DSH_SERVICES_URL && !/^https?:\/\/[^/?#]+\/?$/.test(rawUrl)) {
      throw new Error('DSH_SERVICES_URL must be an origin without a path, query or token')
    }
    let url
    try { url = new URL(rawUrl) } catch { throw new Error('Selected host URL is invalid; supply a loopback origin') }
    // Emit only the origin. A runtime URL may contain a launch token; never return it.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Selected host must be HTTP(S) without embedded credentials')
    }
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
    if (url.hostname !== '[::1]' && !/^127(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(url.hostname)) {
      throw new Error('Only the selected loopback host is supported')
    }
    origin = url.origin
  }
  return { ok: true, profileDir: directory, cli, version: manifest.version, origin, helpArgv: ['node', cli, '--help'] }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  try {
    if (argv.length && (argv.length !== 2 || argv[0] !== '--profile-dir')) {
      throw new Error('Usage: node resolve-cli.mjs [--profile-dir <absolute selected profile>]')
    }
    return { code: 0, output: resolveCli({ env, profileDir: argv[1] }) }
  } catch (error) {
    return { code: 2, output: { ok: false, error: String(error.message) } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = main()
  ;(result.code === 0 ? process.stdout : process.stderr).write(JSON.stringify(result.output, null, 2) + '\n')
  process.exitCode = result.code
}
