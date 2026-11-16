import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, loadPackagedSkill } from '../src/skill-plugin.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('packaged skill supplies native metadata, instructions and package-relative resources', () => {
  const skill = loadPackagedSkill()
  assert.equal(skill.name, 'services-manager')
  assert.equal(skill.source, 'runtime')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: path.join(root, 'skills', 'services-manager') + path.sep })
  assert.equal(skill.path, path.join(skill.resourceBase.path, 'SKILL.md'))
  assert.match(skill.description, /Web/)
  assert.ok(!skill.content.startsWith('---'))
  assert.match(skill.content, /capabilities 包含 attach、status、start、stop、restart/)
  for (const relative of ['SKILL.md', 'scripts/resolve-cli.mjs', 'references/cli.md']) {
    assert.ok(fs.statSync(path.join(skill.resourceBase.path, relative)).isFile())
  }
})

test('skill entry owns only registration and yields its disposer for lifecycle teardown', () => {
  assert.deepEqual(inject, ['skills'])
  let registered, disposed = 0
  const dispose = () => { disposed++ }
  const ctx = {
    skills: { register(skill) { registered = skill; return dispose } },
    effect(fn) { assert.equal(fn(), dispose); return dispose },
  }
  apply(ctx)
  assert.equal(registered.name, 'services-manager')
  dispose()
  assert.equal(disposed, 1)
})

test('published manifest and bundle expose skill entry and every companion resource', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['./skills'], './src/skill-plugin.mjs')
  assert.ok(manifest.files.includes('skills/'))
  assert.ok(manifest.files.includes('locale/skills/'))
  assert.match(fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'), /id: dsh-services-manager-skills\r?\n\s+name: dsh-services-manager\/skills/)
  for (const lang of ['en', 'zh']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, 'locale', 'skills', lang + '.json'), 'utf8'))
    assert.ok(locale.meta.title && locale.meta.description)
  }
  assert.equal(manifest.exports['./skills/icon'], './icon.svg')
})
