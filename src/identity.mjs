/** Resolve only a verified Node script + physical process cwd, never broaden a signature. */
import fs from 'node:fs'
import path from 'node:path'
import { splitCommand } from './command.mjs'
export function canonicalNodeCommand(commandLine, processCwd, expectedCwd) {
  try {
    const argv=splitCommand(commandLine)
    if(!/(?:^|[\\/])node(?:[.]exe)?$/i.test(argv[0]) || argv.length<2) return null
    if(path.isAbsolute(argv[1]) || !/[.](?:mjs|cjs|js)$/i.test(argv[1])) return null
    if(!path.isAbsolute(processCwd) || !path.isAbsolute(expectedCwd)) return null
    const cwd=fs.realpathSync(processCwd), expected=fs.realpathSync(expectedCwd)
    if(cwd!==expected) return null
    const script=fs.realpathSync(path.resolve(cwd,argv[1]))
    if(!script.startsWith(cwd+path.sep) || !fs.statSync(script).isFile()) return null
    argv[1]=script
    return argv.map(word=>word.includes(' ')||/[\\/]/.test(word)?'"'+word+'"':word).join(' ')
  } catch {return null}
}
