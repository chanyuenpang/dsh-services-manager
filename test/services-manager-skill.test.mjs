import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCli, main } from '../skills/services-manager/scripts/resolve-cli.mjs'
import { validateRegistration } from '../src/registration.mjs'

function profileFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-skill profile '))
  const profile = path.join(home, 'profiles', 'selected')
  const pkg = path.join(profile, 'node_modules', 'dsh-services-manager')
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-services-manager', version: '0.2.2' }))
  fs.writeFileSync(path.join(pkg, 'src', 'cli.mjs'), '// offline test fixture')
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return { home, profile, pkg }
}

test('skill resolver uses selected installed CLI, no development checkout or credential output', (t) => {
  const { profile } = profileFixture(t)
  const found = resolveCli({ env: { DSH_PROFILE_DIR: profile, DSH_WEB_URL: 'http://127.0.0.1:6242/?token=DO_NOT_EMIT_THIS', DSH_SERVICES_TOKEN: 'OTHER_PRIVATE_VALUE' } })
  assert.equal(found.origin, 'http://127.0.0.1:6242')
  assert.equal(found.cli, path.join(profile, 'node_modules', 'dsh-services-manager', 'src', 'cli.mjs'))
  assert.deepEqual(found.helpArgv, ['node', found.cli, '--help'])
  assert.ok(!JSON.stringify(found).includes('DO_NOT_EMIT_THIS'))
  assert.ok(!JSON.stringify(found).includes('OTHER_PRIVATE_VALUE'))
})

test('skill resolver honors explicit profile and explicit host ahead of runtime values', (t) => {
  const { profile } = profileFixture(t)
  const found = resolveCli({ profileDir: profile, env: { DSH_PROFILE_DIR: path.join(profile, 'wrong'), DSH_SERVICES_URL: 'http://localhost:4567/', DSH_WEB_URL: 'http://127.0.0.1:6242/' } })
  assert.equal(found.profileDir, profile)
  assert.equal(found.origin, 'http://127.0.0.1:4567')
})

test('skill resolver supports explicit DSH_HOME + DSH_PROFILE and IPv6, never assumes port', (t) => {
  const { home, profile } = profileFixture(t)
  const found = resolveCli({ env: { DSH_HOME: home, DSH_PROFILE: 'selected', DSH_WEB_URL: 'https://[::1]:4567/' } })
  assert.equal(found.profileDir, profile)
  assert.equal(found.origin, 'https://[::1]:4567')
  assert.equal(resolveCli({ env: { DSH_PROFILE_DIR: profile } }).origin, null)
})

test('skill resolver missing selection and invalid selectors fail without scanning', () => {
  for (const env of [{}, { DSH_PROFILE: '..' }, { DSH_PROFILE_DIR: 'relative-profile' }, { DSH_PROFILE: 'selected', DSH_HOME: 'relative-home' }]) {
    assert.throws(() => resolveCli({ env }))
  }
  assert.equal(main(['--unknown'], {}).code, 2)
  assert.equal(main(['--profile-dir'], {}).code, 2)
})

test('skill resolver missing CLI fails and does not modify existing fixture', (t) => {
  const { profile, pkg } = profileFixture(t)
  const cli = path.join(pkg, 'src', 'cli.mjs')
  fs.unlinkSync(cli)
  const before = fs.readdirSync(pkg).sort()
  assert.throws(() => resolveCli({ env: { DSH_PROFILE_DIR: profile } }), /not installed/)
  assert.deepEqual(fs.readdirSync(pkg).sort(), before)
  assert.equal(fs.existsSync(cli), false)
})

test('skill resolver rejects remote, credentials, malformed and canonicalized hosts without echoing secrets', (t) => {
  const { profile } = profileFixture(t)
  for (const url of ['https://example.com:4590/', 'http://user:PRIVATE@127.0.0.1/', 'http://2130706433:4590/', 'http://0x7f000001:4590/', 'http://127.999.0.1/', 'file:///PRIVATE']) {
    const result = main([], { DSH_PROFILE_DIR: profile, DSH_WEB_URL: url })
    assert.equal(result.code, 2, url)
    assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  }
  assert.equal(main([], { DSH_PROFILE_DIR: profile, DSH_SERVICES_URL: 'http://127.0.0.1:4590/?token=PRIVATE' }).code, 2)
})

const skillDir = fileURLToPath(new URL('../skills/services-manager/', import.meta.url))
test('skill frontmatter and companion resources are self-contained', () => {
  const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
  assert.match(text, /^---\r?\nname: services-manager\r?\ndescription: .+\r?\n---/)
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) assert.ok(fs.statSync(path.join(skillDir, match[1])).isFile())
  assert.ok(fs.statSync(path.join(skillDir, 'scripts', 'resolve-cli.mjs')).isFile())
  assert.ok(!text.includes('G:\\Projects\\dsh-plugins'))
  assert.ok(!text.includes('G:/Projects/dsh-plugins'))
})

test('documented registration JSON validates and signature distinguishes project/port', () => {
  const text = fs.readFileSync(path.join(skillDir, 'references', 'cli.md'), 'utf8')
  const example = JSON.parse(text.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1])
  validateRegistration(example)
  assert.equal(example.autostart, false)
  assert.equal(example.autoStopOnExit, true)
  const pattern = new RegExp(example.match.commandLinePattern, 'i')
  assert.equal(pattern.test('node "C:/Projects/example-web/server.mjs" --port 4590'), true)
  assert.equal(pattern.test('node "C:\\Projects\\example-web\\server.mjs" --port=4590'), true)
  assert.equal(pattern.test('node "C:/Projects/other/server.mjs" --port 4590'), false)
  assert.equal(pattern.test('node "C:/Projects/example-web/server.mjs" --port 45901'), false)
})
