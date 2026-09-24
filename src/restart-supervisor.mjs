/**
 * Restart the `dsh web` that owns a port — including the one hosting this conversation.
 *
 * Global version, packaged as the `dsh-restart` skill. The repository copy
 * (`<repo>/tools/restart-host.mjs`) is the same logic wired to that repo's own flow and covered
 * by its unit tests; this one has **no repository dependency** so any agent, in any project, can
 * restart DSH.
 *
 * The job is two statements: stop it, start it. Everything else here exists because of two
 * measured facts (the reasoning is in that repo's ADR-0009), and nothing else is kept:
 *
 * 1. The process running those statements is a **child of the process being stopped**, inside a
 *    Windows job object belonging to the command that started it — so the kill is done by a
 *    supervisor started through **WMI**, which no job of ours owns.
 * 2. The instance it starts must be **detached with its output on a file**: non-detached it dies
 *    with the supervisor, and piped output is an EPIPE that DSH's fail-loud handler turns into
 *    `exit(1)`. Both killed the instance that had just come up.
 *
 * It does not verify anything. Whether the new instance came up is a question for whoever looks
 * next (`/status`, or the log this writes), and a restart a person performs by hand does not
 * verify either.
 *
 * **Announce before you apply.** A restart kills the process that owns the conversation: the
 * agent goes offline, and the page needs the new instance's token. The 60s default grace exists
 * so the warning can be read first — and the skill on top of this script additionally requires an
 * `ask_user_question` answer before `--apply` is run at all.
 *
 * The stop half is a **sweep, not one kill**: after the instance on the port is stopped, the
 * other processes this DSH owns are stopped too — its command subprocesses
 * (`dsh-subprocess-local/lib/runner.js`, the thing actually holding a pwsh/cmd/node command), its
 * own worker children, and the orphans a previous instance left behind. A `dsh` tree that is only
 * half gone is what makes the next start look hung, so the sweep runs before the relaunch rather
 * than after it. `--keep-sandboxes` narrows it back to the target's own tree.
 *
 * Windows only (WMI + Win32_Process + netstat). Usage:
 *   node restart-dsh.mjs                            # dry run: what would happen
 *   node restart-dsh.mjs --apply --grace 60         # do it, 60s from now (the default)
 *   node restart-dsh.mjs --port 3081 --apply        # another instance
 *   node restart-dsh.mjs --cwd G:\some\project      # what the new instance's sessions work in
 *   node restart-dsh.mjs --keep-sandboxes --apply   # stop the target tree only
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** `~/.agents`, found from this script's own location — never from the caller's cwd. */
const agentsRoot = resolve(scriptDir, '..', '..', '..');
/** Everything this tool writes lives here, outside every repository. */
const defaultLogDir = join(agentsRoot, 'logs', 'dsh-restart');
const settle = (ms) => new Promise((done) => setTimeout(done, ms));

/** `--apply` is the only thing that changes behaviour; a dry run is the default. */
export function parseArgs(argv) {
  // 60s, not 20: an agent that restarts this instance must first say so in the conversation, and
  // the message and the disconnect arriving together is the same as no warning at all
  // (「如果有重启的话一定要提前告诉我，不然我不知道你已经掉线了」).
  const options = { apply: false, graceSeconds: 60, port: 3080, dshHome: null, cwd: process.cwd(), logDir: defaultLogDir, keepSandboxes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--supervise') options.supervise = true;
    else if (flag === '--keep-sandboxes') options.keepSandboxes = true;
    else if (flag === '--grace') { options.graceSeconds = Number(argv[index + 1]); index += 1; }
    else if (flag === '--port') { options.port = Number(argv[index + 1]); index += 1; }
    else if (flag === '--dsh-home') { options.dshHome = argv[index + 1]; index += 1; }
    else if (flag === '--cwd') { options.cwd = argv[index + 1]; index += 1; }
    else if (flag === '--log-dir') { options.logDir = argv[index + 1]; index += 1; }
  }
  return options;
}

/**
 * The argv to hand a fresh `dsh`, copied from the target's own command line.
 *
 * Copied, not assumed: a wrong `--profile` costs a login and a wrong `--port` moves the instance
 * away from the page the user is holding. The **subcommand counts** — the live instance's tail is
 * `… bin.js web`, so a flag-only copy would start `dsh` with no command at all.
 * @param commandLine - the target process's command line.
 * @returns the argv for a fresh `dsh` (subcommand first), or `[]` when it cannot be read.
 */
export function launchArgsFrom(commandLine) {
  const text = typeof commandLine === 'string' ? commandLine : '';
  const marker = text.lastIndexOf('bin.js');
  if (marker === -1) return [];
  const tail = text.slice(marker + 'bin.js'.length).trim();
  const args = [];
  const subcommand = tail.match(/^([a-zA-Z][\w-]*)/);
  if (subcommand !== null) args.push(subcommand[1]);
  const profile = tail.match(/--profile\s+("([^"]+)"|(\S+))/);
  const port = tail.match(/--port\s+(\d+)/);
  if (profile !== null) args.push('--profile', profile[2] ?? profile[3]);
  if (port !== null) args.push('--port', port[1]);
  return args;
}

/** The pid listening on a local port, via netstat: the truth, with no dependency. */
function listenerPid(port) {
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[3] !== 'LISTENING' || !columns[1].endsWith(`:${port}`)) continue;
      const pid = Number(columns[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // no netstat: the caller decides what to do with null
  }
  return null;
}

function commandLineOf(pid) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Is this a process this DSH owns — its entry point, or one of the command subprocesses it
 * spawns?
 *
 * The marker is the installed `@deepseek-ai/dsh` path, so every pinned command the harness runs
 * matches: `lib/bin.js web` (the host itself), `dsh-subprocess-local/lib/runner.js` and
 * `dsh-subprocess-windows/lib/runner.js` (the shell wrappers — "sandbox threads" in plain words:
 * the pwsh/cmd/node process a command actually runs in), and `dsh-browser`'s headless child.
 *
 * `node.exe` being the image is not part of the test: the browser helper is node too, and the
 * runner may be started by another runtime. What must *not* match is a line that merely mentions
 * the word dsh — `claw`'s CLI (`--host dsh`), this script itself, and the `dsh-*` packages of
 * unrelated products all fail on the path marker.
 * @param commandLine - a process's command line, as `Win32_Process` reports it.
 * @returns true when this process belongs to this DSH installation.
 */
export function isDshProcess(commandLine) {
  return typeof commandLine === 'string' && /@deepseek-ai[\\/]dsh[\\/]/i.test(commandLine);
}

function commandLines() {
  try {
    const json = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -or $_.Name -like 'dsh*' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8' });
    const parsed = JSON.parse(json.trim() === '' ? '[]' : json);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // No CIM, no sweep: the caller still stops the target it found through netstat.
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop every process of this DSH tree, not just the listener.
 *
 * Killing only the pid on the port leaves the command subprocesses and the worker children it
 * spawned: `runner.js` is not in its parent's job object on the way down, so it survives as an
 * orphan holding a shell, a pipe and sometimes a lock on a log file. Those orphans are what turn
 * "restart DSH" into "the new instance comes up wrong", so they are stopped here — before the
 * relaunch, while nothing new is running yet.
 *
 * @param options.pid - the listener that was already killed, if any; its whole tree goes first.
 * @param options.keepSandboxes - stop that tree only, and leave unrelated `dsh` processes alone.
 * @param options.log - one line per decision, into the restart log.
 * @returns the pids it stopped, in the order it stopped them.
 */
export async function sweepDshProcesses({ pid = null, keepSandboxes = false, log = () => {} } = {}) {
  const self = process.pid;
  const parent = process.ppid;
  const all = commandLines();
  const alive = (candidate) => candidate !== self && candidate !== parent && isAlive(candidate);

  /** The target and everything below it: parent links are the tree, whatever the child's name. */
  const tree = new Set();
  if (pid !== null && isAlive(pid)) {
    let frontier = [pid];
    tree.add(pid);
    for (let depth = 0; depth < 20 && frontier.length > 0; depth += 1) {
      const next = all
        .filter((row) => frontier.includes(row.ParentProcessId) && !tree.has(row.ProcessId))
        .map((row) => row.ProcessId);
      for (const candidate of next) tree.add(candidate);
      frontier = next;
    }
  }

  // Orphans of a previous instance, plus this instance's own workers. Both carry the marker, so
  // the list is "every dsh process that is not inside something we must not touch".
  const identified = all
    .filter((row) => isDshProcess(row.CommandLine))
    .map((row) => row.ProcessId);
  const swept = keepSandboxes ? [...tree] : [...new Set([...tree, ...identified])];
  const targets = swept.filter(alive);
  if (targets.length === 0) {
    log('cleanup: no dsh processes left to stop');
    return [];
  }

  log(`cleanup: stopping ${targets.length} dsh process(es) ${keepSandboxes ? '(target tree only)' : '(whole tree, including command subprocesses)'} — pids ${targets.join(', ')}`);
  for (const candidate of targets) {
    try {
      process.kill(candidate);
    } catch (error) {
      log(`cleanup: kill ${candidate} failed: ${error.message}`);
    }
  }

  // A reaped command subprocess can take a moment to disappear; a second pass is cheap and is
  // the difference between "gone" and "gone except the one that mattered".
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const remaining = targets.filter(isAlive);
    if (remaining.length === 0) break;
    await settle(250);
    if (attempt === 10) log(`cleanup: still alive after 2.5s — pids ${remaining.join(', ')}`);
  }
  return targets;
}

/**
 * Every `dsh … web`-style process with the ports it listens on.
 *
 * Here for the caller who did not name a port: a wrong guess restarts the wrong instance, so the
 * tool shows what is actually running instead of picking for them.
 * @returns `[{ pid, ports, args }]`, newest first is not guaranteed.
 */
export function dshProcesses() {
  const portsByPid = new Map();
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[3] !== 'LISTENING') continue;
      const pid = Number(columns[4]);
      const port = Number(columns[1].slice(columns[1].lastIndexOf(':') + 1));
      if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
      const list = portsByPid.get(pid) ?? [];
      list.push(port);
      portsByPid.set(pid, list);
    }
  } catch {
    // no netstat: every row simply reports no ports
  }
  let rows = [];
  for (const row of commandLines()) {
    const args = launchArgsFrom(row?.CommandLine ?? '');
    if (args.length === 0) continue;
    const ports = (portsByPid.get(row.ProcessId) ?? []).sort((a, b) => a - b);
    rows.push({ pid: row.ProcessId, ports, args });
  }
  return rows;
}

function logTo(logFile, line) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

/** The detached half: stop (the tree), then start. Two statements, and a line for each. */
async function supervise({ port, graceSeconds, dshHome, cwd, logDir, keepSandboxes }) {
  const logFile = join(logDir, 'host-restart.log');
  const childLog = join(logDir, 'dsh-web.log');
  const log = (line) => logTo(logFile, line);
  const oldPid = listenerPid(port);
  const args = oldPid === null ? [] : launchArgsFrom(commandLineOf(oldPid));
  log(`restart: port ${port}, target ${oldPid ?? 'none'}, grace ${graceSeconds}s, args ${JSON.stringify(args)}, cwd ${cwd}`);
  if (oldPid !== null && args.length === 0) {
    log('refusing: the target has no readable subcommand, so a relaunch would start `dsh` bare');
    process.exit(1);
  }
  if (oldPid !== null) {
    await settle(Math.max(0, graceSeconds) * 1000);
    try {
      process.kill(oldPid);
    } catch (error) {
      log(`kill failed: ${error.message}`);
    }
    for (let attempt = 0; attempt < 20 && listenerPid(port) !== null; attempt += 1) await settle(250);
  }
  // Stop before starting: the sweep is here, not after the relaunch, so nothing of the old tree
  // is still holding a shell, a pipe or a log file while the new instance opens its own.
  await sweepDshProcesses({ pid: oldPid, keepSandboxes, log });

  const globalBin = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(globalBin)) {
    log(`cannot find ${globalBin}; start the instance by hand`);
    process.exit(1);
  }
  mkdirSync(logDir, { recursive: true });
  const sink = openSync(childLog, 'a');
  const child = spawn(process.execPath, [globalBin, ...args], {
    cwd,
    env: dshHome === null || dshHome === undefined ? process.env : { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', sink, sink],
    detached: true,
    // Never give the relaunched instance a window: it is a background service, and a stray
    // console on the user's desktop both distracts them and invites a fatal mis-click
    // (closing that window kills the Host).
    windowsHide: true,
  });
  closeSync(sink);
  child.unref();
  log(`started pid ${child.pid}`);
  process.exit(0);
}

// Importing this file for its pure helpers must not run the CLI.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const options = parseArgs(process.argv.slice(2));
if (!isMain) {
  // imported, not run
} else if (options.supervise) {
  await supervise(options);
} else {
  const pid = listenerPid(options.port);
  const logFile = join(options.logDir, 'host-restart.log');
  const cleanup = options.keepSandboxes
    ? '(not swept: --keep-sandboxes)'
    : commandLines().filter((row) => isDshProcess(row.CommandLine)).map((row) => row.ProcessId);
  console.log(JSON.stringify({
    port: options.port,
    targetPid: pid,
    relaunchArgs: pid === null ? [] : launchArgsFrom(commandLineOf(pid)),
    dshHome: options.dshHome ?? process.env.DSH_HOME ?? '(inherited default)',
    cwd: options.cwd,
    graceSeconds: options.graceSeconds,
    cleanupPids: cleanup,
    logFile,
    mode: options.apply ? 'APPLY' : 'DRY RUN',
  }, null, 2));
  if (pid === null) {
    // No listener on the requested port: show what is actually running rather than guess.
    const running = dshProcesses();
    console.log('\nno listener on that port. `dsh` instances found:');
    if (running.length === 0) console.log('  (none — pass --port <n>, or the instance is not running)');
    for (const row of running) {
      console.log(`  pid ${row.pid}  ports ${row.ports.length === 0 ? '(none listening)' : row.ports.join(', ')}  args ${JSON.stringify(row.args)}`);
    }
  }
  if (!options.apply) {
    console.log('\ndry run: nothing was touched. --apply stops the target, sweeps the rest of the dsh tree, and starts it again.');
    if (options.keepSandboxes) console.log('--keep-sandboxes: the sweep is limited to the target\'s own tree.');
    else console.log(`--apply would also stop ${cleanup.length} dsh process(es): pids ${cleanup.join(', ') || '(none)'}.`);
  } else {
    // Through WMI: this process is a child of the very pid that is about to die, and a plain
    // `detached` child stays inside the harness's per-command job object (ADR-0009).
    const superviseArgs = [
      fileURLToPath(import.meta.url), '--supervise',
      '--port', String(options.port),
      '--grace', String(options.graceSeconds),
      '--cwd', options.cwd,
      '--log-dir', options.logDir,
      ...(options.keepSandboxes ? ['--keep-sandboxes'] : []),
      ...(options.dshHome === null ? [] : ['--dsh-home', options.dshHome]),
    ];
    const commandLine = [process.execPath, ...superviseArgs].map((part) => `"${part}"`).join(' ');
    let via = 'wmi';
    try {
      // 直接由 WMI 拉起看守进程。**不要**在这里再套一层 `powershell -WindowStyle Hidden`:
      // 2026-09-18 实测那样会让本调用抛错、退化到下面的 spawn 分支,而 spawn 的看守进程活不过
      // 调用方的 job object —— 结果是"重启静默不发生"(比多一个控制台窗口严重得多)。
      // 桌面窗口问题由子进程的 windowsHide + 之后单独验证过的方案解决,不在这条关键路径上冒险。
      execFileSync('powershell', ['-NoProfile', '-Command', `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' } | Out-Null`], { encoding: 'utf8' });
    } catch {
      via = 'spawn';
      const helper = spawn(process.execPath, superviseArgs, { cwd: options.cwd, env: process.env, stdio: 'ignore', detached: true, windowsHide: true });
      helper.unref();
    }
    logTo(logFile, `requested: port ${options.port}, grace ${options.graceSeconds}s, via ${via}`);
    console.log(`\nAPPLY: restarting port ${options.port} in ${options.graceSeconds}s (via ${via}).`);
    console.log(`stops the target, then the rest of the dsh tree${options.keepSandboxes ? ' (target tree only)' : ''}; then starts the new instance.`);
    console.log(`outcome goes to ${logFile}; this process may be killed in the meantime.`);
  }
}
