import { captureRoleToolAuthority, validRoleToolList } from './src/role-tools.js';
import { readReplacementRecord, eligibilityOf, candidateEligibility, STANDBY_TOOLS } from './src/member-replacement.js';
import { REPLACEMENT_OWNER, readReplacementRow } from './src/replacement-store.js';
import { isReusableLogicalTeamTaskDelegate, registerReusableLogicalTeamTaskDelegate } from './src/team-addressing.js';

const CONFIG_KEYS = ['ownedSessionId', 'roleName', 'personaPrompt', 'tools', 'standbyOperationId', 'replacementOwner'];
const LEAD_NAME = 'lead';

export const name = 'dsh-launcher-role';
export const inject = ['systemPrompt', 'tools', 'agents'];

class LauncherRoleError extends Error {
  constructor(code) { super(code); this.name = 'LauncherRoleError'; this.code = code; }
}
const fail = code => { throw new LauncherRoleError(code); };

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function standbyCallAllowed(exec, operation) {
  if (!operation) return false;
  if (exec.name === 'team_task_get') {
    return exactKeys(exec.arguments, ['task_id'])
      && operation.taskRefs.some(ref => ref.taskId === exec.arguments.task_id);
  }
  if (exec.name !== 'send_message' || !exactKeys(exec.arguments, ['agent', 'message'])
    || exec.arguments.agent !== LEAD_NAME || typeof exec.arguments.message !== 'string') return false;
  let message;
  try { message = JSON.parse(exec.arguments.message); } catch { return false; }
  const keys = operation.configDigest === undefined ? ['ready', 'operation', 'handoff'] : ['ready', 'operation', 'handoff', 'config'];
  return exactKeys(message, keys) && message.ready === true
    && message.operation === operation.id && message.handoff === operation.handoffDigest
    && (operation.configDigest === undefined || message.config === operation.configDigest);
}

function parseConfig(raw) {
  let fields;
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('LAUNCHER_ROLE_INVALID_CONFIG');
    const keys = Reflect.ownKeys(raw);
    if (keys.length === 0 || keys.length > CONFIG_KEYS.length || keys.some(key => !CONFIG_KEYS.includes(key))) fail('LAUNCHER_ROLE_INVALID_CONFIG');
    fields = Object.getOwnPropertyDescriptors(raw);
    for (const required of ['ownedSessionId', 'roleName', 'personaPrompt', 'tools']) {
      if (!Object.hasOwn(fields, required) || !Object.hasOwn(fields[required], 'value')) fail('LAUNCHER_ROLE_INVALID_CONFIG');
    }
  } catch { fail('LAUNCHER_ROLE_INVALID_CONFIG'); }
  const ownedSessionId = fields.ownedSessionId.value, roleName = fields.roleName.value;
  const personaPrompt = fields.personaPrompt.value, inputTools = fields.tools.value;
  if (typeof ownedSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ownedSessionId)) fail('LAUNCHER_ROLE_INVALID_OWNER');
  if (typeof roleName !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(roleName) || roleName === 'lead') fail('LAUNCHER_ROLE_INVALID_NAME');
  if (typeof personaPrompt !== 'string' || personaPrompt.length > 16384 || !personaPrompt.trim() || personaPrompt.includes('\0')) fail('LAUNCHER_ROLE_INVALID_PERSONA');
  if (fields.standbyOperationId !== undefined && !Object.hasOwn(fields.standbyOperationId, 'value')) fail('LAUNCHER_ROLE_INVALID_CONFIG');
  if (raw.standbyOperationId !== undefined && (typeof raw.standbyOperationId !== 'string'
    || !/^replace-[0-9a-f-]{36}$/.test(raw.standbyOperationId))) fail('LAUNCHER_ROLE_INVALID_CONFIG');
  if (!validRoleToolList(inputTools)) fail('LAUNCHER_ROLE_INVALID_TOOLS');
  if (fields.replacementOwner !== undefined && (!Object.hasOwn(fields.replacementOwner, 'value')
    || fields.replacementOwner.value !== REPLACEMENT_OWNER)) fail('LAUNCHER_ROLE_INVALID_CONFIG');
  const tools = [];
  try {
    for (let index = 0; index < inputTools.length; index++) {
      const tool = inputTools[index];
      if (tools.includes(tool)) fail('LAUNCHER_ROLE_INVALID_TOOLS');
      tools.push(tool);
    }
  } catch { fail('LAUNCHER_ROLE_INVALID_TOOLS'); }
  return Object.freeze({ ownedSessionId, roleName, personaPrompt, tools: Object.freeze(tools),
    ...(fields.replacementOwner !== undefined ? { replacementOwner: REPLACEMENT_OWNER } : {}),
    ...(raw.standbyOperationId !== undefined ? { standbyOperationId: raw.standbyOperationId } : {}) });
}

/** Preset contributions only. This module creates no member-state or persona-observation proof. */
export async function apply(ctx, raw) {
  const config = parseConfig(raw);
  if (typeof ctx?.systemPrompt?.section !== 'function' || typeof ctx.on !== 'function') fail('LAUNCHER_ROLE_HOST_UNAVAILABLE');
  const delegated = new Map();
  let root;
  const managedChildren = new Set();
  const unavailable = reason => ({ eligibility: { kind: 'none', operationId: null, reason }, operation: undefined });
  /** Replacement eligibility is re-derived from the durable record on every admission,
   * so a frozen/retired child loses work rights even mid-flight of a live operation.
   * Failure coordinates: a managed candidate or a frozen/retired child whose record
   * cannot be read never regains execution rights. Current-session Presets require
   * their durable root partition even on a fresh registry, before any first read. */
  const currentAdmission = agent => {
    const childId = agent?.session?.id;
    if (typeof childId !== 'string') return unavailable('TEAM_ELIGIBILITY_UNVERIFIABLE');
    let row;
    try {
      if (ctx.agents.get(config.ownedSessionId) !== root) return unavailable('TEAM_ROOT_TOOL_AUTHORITY_CHANGED');
      if (ctx.agents.get(childId) !== agent) return unavailable('TEAM_ROOT_TOOL_AUTHORITY_CHANGED');
      row = readReplacementRow(ctx.get('settings'), config.ownedSessionId, {
        requirePartition: config.replacementOwner !== undefined || config.standbyOperationId !== undefined
          || managedChildren.has(childId),
      });
    } catch (error) {
      if (error?.code === 'REPLACEMENT_STORE_UNAVAILABLE' && config.replacementOwner === undefined
        && config.standbyOperationId === undefined && !managedChildren.has(childId)) {
        return { eligibility: { kind: 'full', operationId: null }, operation: undefined };
      }
      return unavailable('TEAM_ELIGIBILITY_UNVERIFIABLE');
    }
    let record;
    try { record = readReplacementRecord(row?.value); } catch {
      return unavailable('TEAM_ELIGIBILITY_UNVERIFIABLE');
    }
    const operation = config.standbyOperationId === undefined
      ? record.operations.find(entry => entry.oldChildId === childId || entry.newChildId === childId)
      : record.operations.find(entry => entry.id === config.standbyOperationId);
    if (operation) managedChildren.add(childId);
    const admit = eligibility => {
      // Until takeover is proved, the ACKed transfer bundle must still belong
      // to this candidate. Later work uses ordinary native per-task owner/CAS
      // checks; historical handoff tasks do not fence unrelated future work.
      if (eligibility.kind === 'full' && operation?.phase === 'activating'
        && operation.newChildId === childId && operation.configDigest !== undefined) {
        try {
          const teams = ctx.get('agentTeams');
          for (const outcome of operation.taskOutcomes.filter(entry => entry.kind === 'transferred')) {
            if (typeof teams?.getTask !== 'function') return unavailable('TEAM_TASK_OWNERSHIP_UNVERIFIABLE');
            const task = teams.getTask(root, outcome.taskId);
            if (!task || !Number.isInteger(task.revision) || task.revision < outcome.revision
              || !['pending', 'in_progress', 'completed', 'deleted'].includes(task.status)) {
              return unavailable('TEAM_TASK_OWNERSHIP_UNVERIFIABLE');
            }
            if (task.ownerId !== childId) {
              return unavailable('TEAM_TASK_OWNERSHIP_CHANGED');
            }
          }
        } catch { return unavailable('TEAM_TASK_OWNERSHIP_UNVERIFIABLE'); }
      }
      return { eligibility, operation };
    };
    if (config.standbyOperationId !== undefined) {
      if (!operation || (operation.newChildId !== null && operation.newChildId !== childId)) {
        return unavailable('TEAM_CANDIDATE_UNBOUND');
      }
      return admit(candidateEligibility(record, config.standbyOperationId, childId));
    }
    if (!operation && managedChildren.has(childId)) return unavailable('TEAM_ELIGIBILITY_UNVERIFIABLE');
    return admit(eligibilityOf(record, childId));
  };
  ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: config.personaPrompt, interpolate: false });
  // Model-step admission is the earliest shared boundary: it also covers browser
  // prompts that reach deliverPrompt without any tool guard. A retired child is
  // refused here before any model request; a standby child may still read.
  // agent/pre-step is waterfall middleware: the allowed path must call and
  // return next(); returning undefined breaks the native AgentLoop's decision read.
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent;
    if (agent?.session?.header?.parentSession === config.ownedSessionId
      && currentAdmission(agent).eligibility.kind === 'none') return { kind: 'reject' };
    return next();
  });
  ctx.on('agent/created', payload => {
    const agent = payload?.agent;
    if (agent?.session?.header?.origin !== 'subagent') fail('LAUNCHER_ROLE_WRONG_ORIGIN');
    if (agent.session.header.parentSession !== config.ownedSessionId) fail('LAUNCHER_ROLE_WRONG_PARENT');
    if (typeof agent.ctx?.tools?.restrict !== 'function') fail('LAUNCHER_ROLE_TOOLS_UNAVAILABLE');
    try {
      const liveRoot = ctx.agents.get(config.ownedSessionId);
      // Install during the serial creation event; currentAdmission rechecks the
      // exact published child identity before every model step and tool body.
      if (liveRoot?.id !== config.ownedSessionId || liveRoot.session?.id !== config.ownedSessionId
        || liveRoot.session.header?.origin === 'subagent' || (root !== undefined && root !== liveRoot)) {
        fail('LAUNCHER_ROLE_TOOLS_UNAVAILABLE');
      }
      root = liveRoot;
      const mask = [...new Set([...config.tools,
        ...(config.standbyOperationId === undefined ? [] : STANDBY_TOOLS)])];
      const authority = captureRoleToolAuthority(ctx, root, [mask]);
      const shared = new Map(ctx.tools.definitions().map(tool => [tool.name, tool]));
      const rootTools = new Map(ctx.tools.definitions(root).map(tool => [tool.name, tool]));
      for (const name of mask) {
        if (name === 'send_message' || name === 'wait_agent') continue;
        const definition = rootTools.get(name);
        if (definition !== shared.get(name)) {
          // Keep the actual native schema/body and service closure. Never copy
          // a conditional registration without its private activation callback.
          const reusable = isReusableLogicalTeamTaskDelegate(definition);
          if (ctx.tools.executable(name, root) !== definition && !reusable) fail('LAUNCHER_ROLE_TOOLS_UNAVAILABLE');
          const existing = delegated.get(name);
          if (existing !== undefined && existing !== definition) fail('LAUNCHER_ROLE_TOOLS_UNAVAILABLE');
          if (existing === undefined) {
            // Own the definition in the role Preset. The child inherits it, so
            // every subsequent native child/Preset restriction still applies.
            if (reusable) registerReusableLogicalTeamTaskDelegate(ctx, definition);
            else ctx.tools.register(definition);
            delegated.set(name, definition);
          }
        }
      }
      // Child-local pre-step: model-step rejection must not depend on preset-scope
      // event bubbling; a browser prompt into this child is refused here too.
      if (typeof agent.ctx.on === 'function') {
        agent.ctx.on('agent/pre-step', async (payload, next) => {
          if (payload?.agent === agent && currentAdmission(agent).eligibility.kind === 'none') {
            return { kind: 'reject' };
          }
          return next();
        });
      }
      agent.ctx.tools.restrict({ allow: mask });
      agent.ctx.tools.guard(exec => {
        if (exec.agent !== agent) return;
        try {
          if (ctx.agents.get(config.ownedSessionId) !== root) {
            return { reason: 'TEAM_ROOT_TOOL_AUTHORITY_CHANGED',
              info: { name: 'DshRoleToolError', code: 'TEAM_ROOT_TOOL_AUTHORITY_CHANGED' } };
          }
          const admission = currentAdmission(agent), eligibility = admission.eligibility;
          const allowed = eligibility.kind === 'standby' ? STANDBY_TOOLS
            : eligibility.kind === 'full' ? config.tools : [];
          if (!allowed.includes(exec.name)) {
            const code = eligibility.kind === 'none' ? eligibility.reason ?? 'TEAM_MEMBER_RETIRED'
              : eligibility.kind === 'standby' ? 'TEAM_STANDBY_RESTRICTED' : 'TEAM_TOOL_OUT_OF_SCOPE';
            return { reason: code, info: { name: 'DshRoleToolError', code } };
          }
          if (eligibility.kind === 'standby' && !standbyCallAllowed(exec, admission.operation)) {
            return { reason: 'TEAM_STANDBY_RESTRICTED',
              info: { name: 'DshRoleToolError', code: 'TEAM_STANDBY_RESTRICTED' } };
          }
          if (ctx.agents.get(config.ownedSessionId) === root && authority.allows(exec)) return;
        } catch { /* A removed registry or root cannot grant a stale capability. */ }
        return { reason: 'TEAM_ROOT_TOOL_AUTHORITY_CHANGED',
          info: { name: 'DshRoleToolError', code: 'TEAM_ROOT_TOOL_AUTHORITY_CHANGED' } };
      });
    }
    catch { fail('LAUNCHER_ROLE_TOOLS_UNAVAILABLE'); }
  });
}
