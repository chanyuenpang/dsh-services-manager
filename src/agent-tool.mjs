/** Native, profile-scoped attachment and lifecycle. Same manager, no HTTP or credentials. */
import { validateId, validateRegistration } from './registration.mjs'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }) }
const readActions = new Set(['list', 'get', 'status'])
const actions = ['list', 'get', 'status', 'register', 'attach', 'start', 'stop', 'restart']
const repairSteps = {
  UNSUPPORTED_POLICY: 'Explicitly set takeover:match and restartMode:inline, or repair the legacy policy in Settings. No force/supervisor policy is accepted.',
  ABSOLUTE_CWD_REQUIRED: 'Supply the real absolute Host directory for cwd; cross-project directories are allowed.',
  CWD_NOT_FOUND: 'Check that cwd exists on the Host and is a directory.',
  APPROVAL_TARGET_CHANGED: 'The physical cwd changed during approval. Review the directory and submit a new call for fresh approval.',
  CONFIG_REPAIR_REQUIRED: 'Repair invalid entries in Settings without discarding other services, then read a fresh revision.',
}
const messages = {
  AGENT_CONTEXT_REQUIRED: ['A live agent session is required.', 'Use this tool from a DSH agent session.'],
  CAPABILITY_UNAVAILABLE: ['Session authorization is unavailable.', 'Check the installed plugin and Host capabilities.'],
  PERMISSION_DENIED: ['This session cannot register shared Host services.', 'Use an authorized session; read-only sessions cannot register and workspace-write requires approval.'],
  CONFIG_INVALID: ['Invalid service registration or configuration.', 'Review the schema and existing configuration. Supply a stable id, absolute existing cwd, command, fixed port and specific signature for new services; never include credentials.'],
  SERVICE_NOT_FOUND: ['No service has this id.', 'Use list to obtain the current revision before creating the service.'],
  CONFIG_CONFLICT: ['The service configuration changed.', 'Read list/get, review the changes and explicitly submit the new revision. Do not retry blindly.'],
  MANAGER_UNAVAILABLE: ['The service operation could not complete.', 'Read list/get before retrying: a previous commit may have completed. Check Host availability.'],
  CANCELLED: ['The call was cancelled; earlier committed effects may remain.', 'Read get/status before deciding whether to submit again.'],
  PORT_OWNED_BY_OTHER: ['The fixed port belongs to an unverified listener; no takeover was performed.', 'Inspect the precise listener identity. Do not broaden the signature, move the registered port, or kill an unknown process.'],
  TIMEOUT: ['The requested runtime state was not confirmed before the deadline.', 'Read status and get before retrying; saved policy and earlier runtime effects may remain.'],
  OPERATION_FAILED: ['The service operation did not complete.', 'Read status and get; inspect the project entry without exposing credentials.'],
  HEALTH_CHECK_FAILED: ['The listener identity matched but the configured health probe did not succeed.', 'Inspect the project health endpoint; do not report attachment as complete.'],
  MANAGER_DISPOSED: ['The service manager was unloaded during the operation.', 'Check plugin loading, then read get/status before retrying.'],
}
function errorEnvelope(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'MANAGER_UNAVAILABLE'
  const [message, nextStep] = messages[code]
  const details = {}
  if (code === 'CONFIG_CONFLICT') for (const key of ['expectedRevision', 'actualRevision']) {
    if (/^[a-f0-9]{16}$/.test(error?.details?.[key] ?? '')) details[key] = error.details[key]
  }
  if (code === 'CONFIG_INVALID' && Object.hasOwn(repairSteps, error?.details?.reason)) {
    details.reason = error.details.reason
    if (['cwd', 'takeover', 'restartMode'].includes(error.details.field)) details.field = error.details.field
  }
  for (const key of ['registered', 'registrationChanged', 'policyCommitted', 'autostart', 'runtimeMayHaveChanged']) {
    if (typeof error?.details?.[key] === 'boolean') details[key] = error.details[key]
  }
  for (const key of ['port', 'pid']) if (Number.isInteger(error?.details?.[key]) && error.details[key] > 0) details[key] = error.details[key]
  if (/^[a-f0-9]{16}$/.test(error?.details?.configRevision ?? '')) details.configRevision = error.details.configRevision
  if (['preparing', 'stopping', 'starting', 'verifying'].includes(error?.details?.phase)) details.phase = error.details.phase
  return { ok: false, error: { code, message, details, nextStep: repairSteps[details.reason] ?? nextStep } }
}
const str = { type: 'string', minLength: 1 }
const serviceProperties = {
  id: { ...str, description: 'Exact stable id; dsh is reserved. Existing ids patch only explicitly supplied fields.' },
  title: str, command: { ...str, description: 'Trusted persistent launch command; no credentials, shell pipelines or redirection. Required on create.' },
  cwd: { ...str, description: 'Absolute existing Host directory. Cross-project directories are allowed. Required on create.' },
  port: { type: 'integer', minimum: 1, maximum: 65535 }, host: str, url: { type: ['string', 'null'] },
  autostart: { type: 'boolean', description: 'Default false on create. True schedules future plugin-load recovery, NOT immediate start; set only if requested.' },
  autoStopOnExit: { type: 'boolean' }, takeover: { type: 'string', enum: ['match'] }, restartMode: { type: 'string', enum: ['inline'] },
  match: { type: 'object', properties: { commandLinePattern: { ...str, description: 'Specific regex for the actual listener, preferably absolute entry + port. Required on create; never broaden to bypass an identity failure.' } }, additionalProperties: false },
  probe: { type: 'object', properties: { path: { type: ['string', 'null'] }, expectStatus: { type: ['integer', 'null'], minimum: 100, maximum: 599 }, intervalMs: { type: ['integer', 'null'], minimum: 1 } }, additionalProperties: false },
}
function validate(args) {
  if (!object(args) || !actions.includes(args.action)) fail('CONFIG_INVALID')
  const registration = ['register', 'attach'].includes(args.action)
  const allowed = args.action === 'list' ? ['action', 'offset', 'limit'] : registration ? ['action', 'service', 'expectedRevision'] : readActions.has(args.action) ? ['action', 'id'] : ['action', 'id', 'expectedRevision']
  if (Object.keys(args).some((key) => !allowed.includes(key))) fail('CONFIG_INVALID')
  if (args.action === 'list') {
    if (!Number.isInteger(args.offset ?? 0) || (args.offset ?? 0) < 0 || !Number.isInteger(args.limit ?? 25) || (args.limit ?? 25) < 1 || (args.limit ?? 25) > 100) fail('CONFIG_INVALID')
  } else if (registration) {
    validateRegistration(args.service)
    if (Object.keys(args.service).some((key) => !Object.hasOwn(serviceProperties, key))) fail('CONFIG_INVALID')
    if (args.action === 'attach' && args.service.autostart === false) fail('CONFIG_INVALID')
  } else validateId(args.id)
  if (!readActions.has(args.action) && (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(args.expectedRevision))) fail('CONFIG_INVALID')
}
function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin + '/' : null } catch { return null }
}
function definitionView(service) {
  return {
    id: service.id, title: service.title, cwd: service.cwd, port: service.port, host: service.host,
    url: safeUrl(service.url), autostart: service.autostart, autoStopOnExit: service.autoStopOnExit,
    commandConfigured: Boolean(service.command), signatureConfigured: Boolean(service.match?.commandLinePattern),
    envConfigured: Object.keys(service.env ?? {}).length > 0,
    takeover: service.takeover, restartMode: service.restartMode,
  }
}

export function createAgentTool(ctx, manager) {
  const definition = {
    name: 'services_manager',
    description: 'Attach and control trusted local Web products in this DSH Desktop/Web Host without tokens or browser authentication. First list/get to review configRevision. attach(service,expectedRevision) registers one stable id, enables autostart and ensures a verified healthy listener; register only saves, without starting. status(id) returns fresh identity/health evidence, never raw commands or credentials. start/stop(id,expectedRevision) persist autostart true/false; restart preserves policy. All writes need authorized session permissions; workspace-write requires single-call approval. No force, port drift, unknown-process killing, env writes, arbitrary RPC or DSH restart. Existing definitions are preserved. After any uncertain outcome read get/status before retrying.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: actions },
        offset: { type: 'integer', minimum: 0, description: 'List only; zero-based offset, default 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'List only; page size, default 25.' },
        id: { ...str, description: 'Exact stable service id for get/status/start/stop/restart.' },
        expectedRevision: { ...str, description: 'Required for every mutation; configRevision from the reviewed list/get/status.' },
        service: { type: 'object', properties: serviceProperties, required: ['id'], additionalProperties: false, description: 'Register or attach. Create requires command/cwd/port/match. Omitted fields preserved; attach enables autostart and ensures running.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, value: { type: 'object', additionalProperties: true }, error: { type: 'object', additionalProperties: true } }, required: ['ok'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: (args) => readActions.has(args?.action),
    async execute(input, exec) {
      try {
        if (!exec?.agent?.session || exec.agent.id !== exec.agent.session.id) fail('AGENT_CONTEXT_REQUIRED')
        if (typeof ctx.sandboxPolicy?.resolve !== 'function') fail('CAPABILITY_UNAVAILABLE')
        const args = JSON.parse(JSON.stringify(input)) // freeze the approval's exact intent
        validate(args)
        const cancelled = () => { if (exec.signal?.aborted) fail('CANCELLED') }
        const policy = () => {
          const mode = ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode
          if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) fail('CAPABILITY_UNAVAILABLE')
          return mode
        }
        cancelled()
        const mode = policy()
        if (!readActions.has(args.action)) {
          let approved = false
          let approvedCwd
          if (mode === 'read-only') fail('PERMISSION_DENIED')
          const intent = args.action === 'register' ? manager.agentIntent(args.service, args.expectedRevision) : manager.agentOperationIntent(args)
          if (mode === 'workspace-write') {
            const approval = ctx.get('approval')
            if (!approval?.request) fail('PERMISSION_DENIED')
            const reason = args.action === 'register'
              ? `Register shared Host service ${args.service.id}; cwd=${intent.cwd}; fields=${Object.keys(args.service).join(',')}; effective autostart=${intent.autostart} (future plugin load only). No immediate process start.`
              : `Service ${args.action}: ${intent.id}; cwd=${intent.cwd}; fixed port=${intent.port}; effective autostart=${intent.autostart}. Controls only verified project listeners; no DSH restart.`
            let outcome
            try { outcome = await approval.request({ agent: exec.agent, callId: exec.callId, toolName: definition.name, reason, signal: exec.signal }) }
            catch { cancelled(); fail('PERMISSION_DENIED') }
            if (outcome !== 'allowed-once') fail('PERMISSION_DENIED')
            approved = true
          }
          approvedCwd = intent.cwd
          const authorize = () => {
            cancelled()
            const currentMode = policy()
            if (currentMode === 'read-only' || (currentMode === 'workspace-write' && !approved)) fail('PERMISSION_DENIED')
          }
          authorize()
          if (args.action === 'register') return { ok: true, value: await manager.agentRegister(args.service, args.expectedRevision, approvedCwd) }
          const value = await manager.agentOperate(args, { authorize, approvedCwd })
          if (value.runtime) value.runtime.url = safeUrl(value.runtime.url)
          return { ok: true, value }
        }
        if (args.action === 'status') {
          const value = await manager.agentStatus(args.id, { check: () => { cancelled(); policy() } })
          value.url = safeUrl(value.url)
          return { ok: true, value }
        }
        const { services, configRevision } = manager.agentDefinitions()
        if (args.action === 'get') {
          const service = services.find((entry) => entry.id === args.id)
          if (!service) fail('SERVICE_NOT_FOUND')
          return { ok: true, value: { service: definitionView(service), configRevision } }
        }
        const offset = args.offset ?? 0, limit = args.limit ?? 25
        const entries = services.slice(offset, offset + limit).map(definitionView)
        return { ok: true, value: { services: entries, total: services.length, nextOffset: offset + entries.length < services.length ? offset + entries.length : null, configRevision, runtimeObserved: false, capabilities: actions } }
      } catch (error) { return errorEnvelope(error) }
    },
  }
  return definition
}

export function registerAgentTool(ctx, manager) {
  // Optional child injection keeps the existing UI working on Hosts without agent tools.
  ctx.inject(['tools', 'sandboxPolicy'], (scope) => {
    scope.effect(() => scope.tools.register(createAgentTool(scope, manager)))
    console.log('[dsh-services-manager] agent tool registered: services_manager')
  })
}
