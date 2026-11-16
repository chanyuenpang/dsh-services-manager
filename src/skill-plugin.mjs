/** Package-owned skill registration: no writes to user homes or service state. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-services-manager-skills'
export const inject = ['skills']

export function loadPackagedSkill() {
  const directory = fileURLToPath(new URL('../skills/services-manager/', import.meta.url))
  const instructionPath = path.join(directory, 'SKILL.md')
  const text = fs.readFileSync(instructionPath, 'utf8')
  // The package owns this small, plain-scalar frontmatter; reject an invalid release.
  const match = /^---\r?\nname: (services-manager)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(text)
  if (!match || !match[2].trim() || !match[3].trim()) throw new Error('Invalid packaged services-manager skill')
  return {
    name: match[1],
    description: match[2].trim(),
    content: match[3].trim(),
    source: 'runtime',
    path: instructionPath,
    resourceBase: { kind: 'directory', path: directory },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

export function apply(ctx) {
  const skill = loadPackagedSkill()
  ctx.effect(() => ctx.skills.register(skill))
}
