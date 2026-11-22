import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { types } from 'node:util';
import { parse } from 'node:path';
import { fail } from './config.js';
import { parseLauncherConfig, validateLauncherTemplate } from './launcher-config.js';
import { applyLauncher } from './launcher-driver.js';
import { defaultWorkTemplate } from './role-tools.js';
import { REPLACEMENT_OWNER, readReplacementRow, createReplacementStore } from './replacement-store.js';
import { launcherTemplateFingerprint } from './launcher-template.js';
import { readReplacementRecord, eligibilityOf } from './member-replacement.js';
import { observeLauncherMembers } from './launcher-native.js';
import { installRootAddressing } from './team-addressing.js';
import { rosterOf } from './member-roster.js';

const MEMBER_COMMANDS = ['replace ', 'recover ', 'cancel ', 'add ', 'remove '];
const memberCommand = raw => MEMBER_COMMANDS.some(prefix => raw.startsWith(prefix));

const digest = value => createHash('sha256').update(value).digest('hex');
const codeOf = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'CURRENT_SESSION_SETUP_FAILED';

/** Legacy releases retained a successful native launch receipt, not the whole
 * template. Only an exact fingerprint plus the original catalog identities can
 * authenticate a supplied snapshot; changed defaults cannot replace it. */
export function verifyLegacyBinding(events, members, scoped) {
  const fingerprint = launcherTemplateFingerprint(validateLauncherTemplate(scoped));
  const own = events ?? [], runs = new Set(own.filter(event => event.type === 'command/run'
    && event.data?.name === 'dsh-team' && event.data.args?.trim() === 'launch').map(event => event.data.commandId));
  for (const event of [...own].reverse()) {
    if (event.type !== 'command/done' || event.data?.kind !== 'success' || !runs.has(event.data.commandId)) continue;
    let receipt;
    try { receipt = JSON.parse(event.data.text); } catch { continue; }
    if (receipt?.ok !== true || receipt.mode !== 'launch' || receipt.templateFingerprint !== fingerprint
      || !Array.isArray(receipt.members) || receipt.members.length !== scoped.members.length) continue;
    if (scoped.members.every(role => {
      const saved = receipt.members.filter(member => member.name === role.name && member.agentPreset === role.agent_preset);
      return saved.length === 1 && members.some(member => member.id === saved[0].id && member.name === role.name);
    })) return true;
  }
  return false;
}

function options(raw) {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('INVALID_CURRENT_SESSION_CONFIG');
  const allowed = ['mode', 'template', 'timeoutMs', 'maxStreams'];
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail('INVALID_CURRENT_SESSION_CONFIG');
  }
  if (raw.mode !== 'current-session') fail('INVALID_CURRENT_SESSION_CONFIG');
  const timeoutMs = raw.timeoutMs ?? 120000;
  const streams = raw.maxStreams ?? {};
  // Reuse the startup bounds parser; these placeholders are never a runtime binding.
  const bounds = parseLauncherConfig({ mode: 'launcher', ownedSessionId: 'session-00000000-0000-4000-8000-000000000000',
    workspace: parse(process.cwd()).root, runTag: 'current-config', timeoutMs, templateSha256: '0'.repeat(64),
    startup: { maxTokens: 1024, maxStreams: streams } });
  return { timeoutMs, maxStreams: bounds.startup.maxStreams, template: raw.template };
}

function assertRoot(ctx, agent, binding) {
  if (!agent || typeof agent.id !== 'string' || !/^session-[a-f0-9-]{36}$/.test(agent.id)
    || agent.session?.id !== agent.id || ctx.agents.get(agent.id) !== agent
    || agent.session.header?.origin === 'subagent') fail('WRONG_AGENT');
  const workspace = ctx.workingDirectory.get(agent.session);
  if (binding && (agent.id !== binding.ownedSessionId || workspace !== binding.workspace)) {
    fail('CURRENT_SESSION_BINDING_CHANGED');
  }
  return workspace;
}

/** One installed command; every root gets native-owned, independently scoped role Presets. */
export async function applyCurrentLauncher(ctx, raw, nativeSubagent, controlEntry, liveConfig) {
  const config = options(raw);
  if (typeof ctx.plugin !== 'function' || typeof ctx.commands?.register !== 'function'
    || typeof ctx.agents?.get !== 'function' || typeof ctx.agents.list !== 'function'
    || typeof ctx.on !== 'function' || typeof ctx.effect !== 'function'
    || typeof ctx.workingDirectory?.get !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
  const bundled = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
  const input = config.template ?? bundled;
  validateLauncherTemplate(input);
  const template = structuredClone(input);
  const defaultTemplate = agent => {
    const current = typeof liveConfig?.readTemplate === 'function' ? liveConfig.readTemplate() ?? defaultWorkTemplate(ctx, agent, bundled)
      : config.template === undefined ? defaultWorkTemplate(ctx, agent, bundled) : template;
    validateLauncherTemplate(current);
    return structuredClone(current);
  };
  const instances = new Map();
  const prepareRoot = liveConfig?.prepareRoot ?? (agent => installRootAddressing(ctx, agent));
  let closing = false, busy = false, outstanding = false;

  async function readyRoot(agent) {
    const instance = instances.get(agent.id);
    assertRoot(ctx, agent, instance.config);
    const handler = await instance.ready;
    await prepareRoot(agent);
    if (closing) fail('UNLOADING');
    assertRoot(ctx, agent, instance.config);
    return handler;
  }

  function installBinding(rootId, workspace, scoped, record) {
    const suffix = digest(rootId).slice(0, 24);
    validateLauncherTemplate(scoped);
    if (scoped.members.some(member => member.agent_preset !== `dsh-current-${suffix}-${member.name}`)) fail('CURRENT_SESSION_BINDING_CHANGED');
    const bound = parseLauncherConfig({ mode: 'launcher', ownedSessionId: rootId, workspace,
      runTag: `current-${suffix}`, timeoutMs: config.timeoutMs, templateSha256: digest(JSON.stringify(scoped)),
      startup: { maxTokens: 1024, maxStreams: config.maxStreams } });
    const instance = { config: bound };
    instances.set(rootId, instance);
    instance.ready = (async () => {
      let handler;
      const module = { name: `current-team-${suffix}`,
        inject: ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections',
          'agentTeams', 'workingDirectory', 'settings', 'sessionQuery', 'sessions'], async apply(inner) {
        await applyLauncher(inner, bound, nativeSubagent, controlEntry, {
          template: scoped, assertOwned: caller => assertRoot(ctx, caller, bound),
          replacementOwner: REPLACEMENT_OWNER, replacementRecord: record,
          baseBinding: JSON.stringify({ workspace, template: scoped }),
          capture(value) { handler = value; },
        });
      } };
      instance.fiber = ctx.plugin(module);
      await instance.fiber;
      if (closing) fail('UNLOADING');
      if (typeof handler !== 'function') fail('CURRENT_SESSION_SETUP_FAILED');
      return handler;
    })();
    return instance.ready;
  }

  function savedBinding(record) {
    let binding;
    try { binding = JSON.parse(record.baseBinding); } catch { fail('REPLACEMENT_BASE_BINDING_UNAVAILABLE'); }
    if (!binding || typeof binding !== 'object' || Object.keys(binding).length !== 2
      || typeof binding.workspace !== 'string' || !Object.hasOwn(binding, 'template')) fail('REPLACEMENT_BASE_BINDING_UNAVAILABLE');
    validateLauncherTemplate(binding.template);
    return binding;
  }

  async function bindingFor(agent, originalTemplate, signal) {
    const workspace = assertRoot(ctx, agent), existing = instances.get(agent.id);
    if (existing) {
      return readyRoot(agent);
    }
    const record = readReplacementRecord(readReplacementRow(ctx.settings, agent.id).value);
    if (record.baseBinding !== undefined) {
      const binding = savedBinding(record);
      if (binding.workspace !== workspace) fail('CURRENT_SESSION_BINDING_CHANGED');
      await installBinding(agent.id, workspace, binding.template, record);
      return readyRoot(agent);
    }
    if (record.operations.length) fail('REPLACEMENT_BASE_BINDING_UNAVAILABLE');
    const suffix = digest(agent.id).slice(0, 24), scoped = originalTemplate === undefined
      ? defaultTemplate(agent) : structuredClone(originalTemplate);
    validateLauncherTemplate(scoped);
    for (const member of scoped.members) member.agent_preset = `dsh-current-${suffix}-${member.name}`;
    const observation = await observeLauncherMembers(ctx, agent, signal);
    if (observation.complete !== true) fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
    if (observation.members.length && !verifyLegacyBinding(agent.session.snapshotEvents?.(), observation.members, scoped)) {
      fail('REPLACEMENT_ORIGINAL_TEMPLATE_REQUIRED');
    }
    if (observation.members.length) {
      for (const role of scoped.members) {
        const member = observation.members.find(member => member.name === role.name);
        if (typeof ctx.sessionQuery?.observeSession !== 'function') fail('REPLACEMENT_SESSION_UNOBSERVABLE');
        const source = await ctx.sessionQuery.observeSession(member.id, { signal });
        try {
          if (source.header?.id !== member.id || source.header.parentSession !== agent.id
            || source.header.agentPreset !== role.agent_preset || source.header.cwd !== workspace) {
            fail('CURRENT_SESSION_BINDING_CHANGED');
          }
        } finally { source[Symbol.dispose](); }
      }
    }
    // Persist before registering a managed Preset: even a plan followed by an
    // existing native child's continuation must have a verifiable partition.
    const saved = await createReplacementStore(ctx.settings, agent.id).ensure(JSON.stringify({ workspace, template: scoped }));
    await installBinding(agent.id, workspace, scoped, saved);
    return readyRoot(agent);
  }

  // Restore original and replacement Presets before any cold member can be
  // continued. The running native row becomes readable after this apply ends.
  const restoreFailures = new Map();
  for (const [rootId, value] of Object.entries(liveConfig?.readRecords?.() ?? {})) {
    try {
      const record = readReplacementRecord(value);
      if (record.baseBinding === undefined) {
        if (record.operations.length) fail('REPLACEMENT_BASE_BINDING_UNAVAILABLE');
        continue;
      }
      const binding = savedBinding(record);
      await installBinding(rootId, binding.workspace, binding.template, record);
    } catch (error) { restoreFailures.set(rootId, codeOf(error)); }
  }
  // Serial native creation covers cold resume before its first model/tool step;
  // the scan covers roots already alive when this profile entry is reloaded.
  const prepareRetainedRoot = async agent => {
    if (agent?.session?.header?.origin === 'subagent') return;
    if (restoreFailures.has(agent?.id)) fail(restoreFailures.get(agent.id));
    if (instances.has(agent?.id)) await readyRoot(agent);
  };
  ctx.on('agent/created', ({ agent }) => prepareRetainedRoot(agent));
  for (const agent of ctx.agents.list()) await prepareRetainedRoot(agent);

  async function invoke(request) {
    try {
      if (closing) fail('UNLOADING');
      const raw = request.rawInput?.trim();
      if (outstanding) fail('OUTSTANDING_LAUNCHER_OPERATION');
      if (busy) fail('BUSY');
      if (!(raw && (['plan', 'launch', 'restore'].includes(raw) || memberCommand(raw)))
        || !Array.isArray(request.attachments) || request.attachments.length) fail('USAGE_PLAN_LAUNCH_RESTORE_ONLY');
      request.signal.throwIfAborted(); assertRoot(ctx, request.agent);
      if (restoreFailures.has(request.agent.id)) fail(restoreFailures.get(request.agent.id));
      busy = true;
      try {
        const handler = await bindingFor(request.agent, undefined, request.signal);
        if (closing) fail('UNLOADING');
        request.signal.throwIfAborted();
        const result = await handler(request), receipt = JSON.parse(result.text);
        if (!memberCommand(raw)
          && (receipt.reconciliationRequired || receipt.code?.endsWith('_DRAINING_GUARD_RETAINED'))) outstanding = true;
        return result;
      } finally { busy = false; }
    } catch (error) {
      return { kind: 'error', text: JSON.stringify({ code: codeOf(error), stopFurtherMutation: true, noAutomaticRetry: true }) };
    }
  }

  const unregister = ctx.commands.register({ name: 'dsh-team', description: 'Build or maintain this session team',
    input: { hint: 'plan | launch | restore | replace | recover | add | remove', attachments: false }, handler: invoke });
  ctx.effect(function* () {
    yield () => { closing = true; return unregister(); };
  });
  return { defaultTemplate, hasBinding: id => instances.has(id), assertRoot: agent => assertRoot(ctx, agent),
    async replacement({ agent, signal, action, request, expectedOldChildId, operationId, originalTemplate }) {
      assertRoot(ctx, agent); signal.throwIfAborted();
      if (closing) fail('UNLOADING');
      if (action === 'adopt') {
        if (busy || outstanding) fail('BUSY');
        busy = true;
        try {
          validateLauncherTemplate(originalTemplate);
          const existing = readReplacementRecord(readReplacementRow(ctx.settings, agent.id).value);
          if (instances.has(agent.id) || existing.baseBinding !== undefined || existing.operations.length) fail('CURRENT_SESSION_ALREADY_BOUND');
          await bindingFor(agent, originalTemplate, signal);
          return { ok: true, action: 'adopt', revision: readReplacementRow(ctx.settings, agent.id).revision };
        } finally { busy = false; }
      }
      const row = readReplacementRow(ctx.settings, agent.id), record = readReplacementRecord(row.value);
      // The team is the bound base template plus explicit membership; unbound roots preview the defaults.
      const roster = rosterOf(record, (record.baseBinding !== undefined ? savedBinding(record).template
        : defaultTemplate(agent)).members);
      if (action === 'inspect') {
        const observation = await observeLauncherMembers(ctx, agent, signal);
        const roles = roster.members.map(({ name: role, origin, phase, childId }) => {
          const active = record.operations.findLast(op => op.role === role && op.phase === 'active'
            && eligibilityOf(record, op.newChildId).kind === 'full');
          const member = observation.members.find(item => active ? item.id === active.newChildId : item.name === role);
          return { role, origin, ...(origin === 'added' ? { additionPhase: phase } : {}),
            currentChildId: member?.id ?? (origin === 'added' && phase !== 'aborted' ? childId : null) };
        });
        const tasks = ctx.agentTeams.isEnabled(agent) ? await ctx.agentTeams.listTasks(agent) : [];
        return { ok: true, revision: row.revision, record, roles, removed: roster.removed, observation, tasks,
          restorationFailure: restoreFailures.get(agent.id) ?? null };
      }
      if (action === 'replace' && !roster.members.some(member => member.name === request.role)) fail('REPLACEMENT_ROLE_NOT_IN_TEAM');
      if (action === 'add') return JSON.parse((await invoke({ agent, signal, rawInput: `add ${JSON.stringify(request.member)}`, attachments: [] })).text);
      if (action === 'remove') return JSON.parse((await invoke({ agent, signal, rawInput: `remove ${request.name}`, attachments: [] })).text);
      const rawInput = ['recover', 'cancel'].includes(action) ? `${action} ${operationId}`
        : `replace ${request.role} ${JSON.stringify({ ...request, expectedOldChildId })}`;
      return JSON.parse((await invoke({ agent, signal, rawInput, attachments: [] })).text);
    } };

}
