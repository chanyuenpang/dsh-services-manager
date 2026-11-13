// Run the exact installed Desktop CLI, including ASAR support, without GUI-shell races.
import { spawnSync } from 'node:child_process'
const executable = process.env.DSH_TEST_EXECUTABLE
const entry = process.env.DSH_TEST_CLI
if (!executable || !entry) throw new Error('Set DSH_TEST_EXECUTABLE and DSH_TEST_CLI explicitly')
const result = spawnSync(executable, ['--expose-internals', entry, ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
