/** Strict agent registration contract, also enforced by the host (not just the CLI). */
const fields = new Set(['id', 'title', 'command', 'cwd', 'port', 'host', 'url', 'autostart', 'autoStopOnExit', 'env', 'match', 'probe', 'takeover', 'restartMode'])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = (message) => { throw Object.assign(new Error(message), { code: 'CONFIG_INVALID' }) }
export function validateId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id === 'dsh') invalid('id must be explicit, stable, non-reserved: [a-zA-Z0-9][a-zA-Z0-9._-]* (no trimming or truncation)')
  return id
}
export function validateRegistration(input) {
  if (!object(input)) invalid('service must be a JSON object')
  for (const key of Object.keys(input)) if (!fields.has(key)) invalid('Unknown service field: ' + key)
  validateId(input.id)
  for (const key of ['title', 'command', 'cwd', 'host']) if (key in input && (typeof input[key] !== 'string' || !input[key].trim())) invalid(key + ' must be a non-empty string')
  if ('url' in input && input.url !== null && typeof input.url !== 'string') invalid('url must be a string or null')
  if ('port' in input && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) invalid('port must be an integer in 1..65535')
  for (const key of ['autostart', 'autoStopOnExit']) if (key in input && typeof input[key] !== 'boolean') invalid(key + ' must be boolean')
  if ('takeover' in input && input.takeover !== 'match') invalid('takeover must be match; force is not supported')
  if ('restartMode' in input && input.restartMode !== 'inline') invalid('restartMode must be inline; host restart is not supported')
  if ('env' in input && (!object(input.env) || Object.values(input.env).some((v) => typeof v !== 'string'))) invalid('env must map names to strings')
  for (const [key, allowed] of [['match', ['commandLinePattern']], ['probe', ['path', 'expectStatus', 'intervalMs']]]) {
    if (!(key in input)) continue
    if (!object(input[key])) invalid(key + ' must be an object')
    for (const field of Object.keys(input[key])) if (!allowed.includes(field)) invalid('Unknown ' + key + ' field: ' + field)
  }
  if ('commandLinePattern' in (input.match ?? {})) {
    if (typeof input.match.commandLinePattern !== 'string' || !input.match.commandLinePattern.trim()) invalid('match.commandLinePattern must be a non-empty string')
    try { new RegExp(input.match.commandLinePattern, 'i') } catch { invalid('match.commandLinePattern must be a valid regular expression') }
  }
  const probe = input.probe ?? {}
  if ('path' in probe && probe.path !== null && typeof probe.path !== 'string') invalid('probe.path must be string or null')
  if ('expectStatus' in probe && probe.expectStatus !== null && (!Number.isInteger(probe.expectStatus) || probe.expectStatus < 100 || probe.expectStatus > 599)) invalid('probe.expectStatus must be null or HTTP status 100..599')
  if ('intervalMs' in probe && probe.intervalMs !== null && (!Number.isInteger(probe.intervalMs) || probe.intervalMs < 1)) invalid('probe.intervalMs must be null or a positive integer')
  return input
}

export function mergeRegistration(before, input) {
  validateRegistration(input)
  if (!before && (!input.command || !input.cwd || !input.port || !input.match?.commandLinePattern)) invalid('New registration requires command, cwd, port and match.commandLinePattern')
  const merged = { ...(before ?? { autostart: false }), ...input }
  for (const key of ['probe', 'match', 'env']) if (key in input) merged[key] = { ...(before?.[key] ?? {}), ...input[key] }
  return merged
}
