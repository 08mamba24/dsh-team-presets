import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { checkedControlEntry, delegationFailure } from './team-driver.js';
import { validRoleToolList } from './role-tools.js';

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SPAWN = 'dsh_team_launcher_spawn';
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const roleName = value => typeof value === 'string' && NAME.test(value) && value !== 'lead';
const unavailable = () => ({ complete: false, members: [], reason: 'NATIVE_CATALOG_UNAVAILABLE' });
const incomplete = () => ({ complete: false, members: [], reason: 'NATIVE_CATALOG_INCOMPLETE' });
const routeOf = value => value && text(value.provider, 200) && text(value.model, 200)
  ? { provider: value.provider, model: value.model,
    ...(text(value.reasoningEffort, 200) ? { reasoningEffort: value.reasoningEffort } : {}) } : undefined;
const sameRoute = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort;

class LauncherNativeError extends Error {
  constructor(code, cleanupFailed = false) {
    super(code); this.name = 'LauncherNativeError'; this.code = code;
    if (cleanupFailed) this.cleanupFailed = true;
  }
}
const fail = code => { throw new LauncherNativeError(code); };

function sameLive(ctx, root, member, agent) {
  try {
    return ctx.agents?.get(member.id) === agent && agent.id === member.id && agent.session?.id === member.id
      && agent.session.header?.origin === 'subagent' && agent.session.header.parentSession === root.id;
  } catch { return false; }
}

async function observeLive(ctx, root, member, signal) {
  const base = { ...member, unobservableFields: ['personaPrompt'] };
  let agent;
  try { agent = ctx.agents?.get(member.id); } catch { return base; }
  if (!agent || !sameLive(ctx, root, member, agent)) return base;
  const facts = {};
  try {
    const preset = ctx.agentPresets?.composedPreset(agent.ctx);
    if (text(preset, 200)) facts.agentPreset = preset;
  } catch { /* The preset field remains unknown; a header id is not a substitute. */ }
  let selection, route;
  try { selection = agent.model?.current(); route = routeOf(selection); } catch { /* No options/default fallback. */ }
  if (route) Object.assign(facts, route, { routeEvidence: 'effective-next-step-only' });
  if (agent.status === 'idle' || agent.status === 'running') facts.status = agent.status;
  if (agent.status === 'idle' && route && typeof agent.ctx?.tools?.resolve === 'function') {
    let toolSet, names;
    try {
      if (!sameLive(ctx, root, member, agent) || agent.status !== 'idle') return base;
      toolSet = await agent.ctx.tools.resolve({ agent, modelSelection: selection, signal });
      signal.throwIfAborted();
      if (!sameLive(ctx, root, member, agent) || agent.status !== 'idle') return base;
      let afterRoute;
      try { afterRoute = routeOf(agent.model.current()); } catch { return base; }
      if (!sameRoute(route, afterRoute)) return base;
      names = [...toolSet.view(agent).keys()];
      if (names.some(name => !text(name, 200))) names = undefined;
    } catch { names = undefined; }
    finally {
      if (toolSet) { try { toolSet.dispose(); } catch { names = undefined; } }
    }
    if (!sameLive(ctx, root, member, agent) || agent.status !== 'idle') return base;
    if (names) facts.nativeToolAllowlist = [...names].sort();
  }
  if (!sameLive(ctx, root, member, agent)) return base;
  return { ...base, ...facts };
}

/** Catalog completeness is distinct from live-field knowledge. Persona is never observed here. */
export async function observeLauncherMembers(ctx, root, signal = new AbortController().signal) {
  let rows;
  try {
    signal.throwIfAborted();
    if (!text(root?.id, 200) || typeof ctx.subagents?.listDescendants !== 'function') return unavailable();
    rows = await ctx.subagents.listDescendants(root.id, signal);
    signal.throwIfAborted();
  } catch { return unavailable(); }
  const catalog = [], anonymousForeignIds = [];
  const nodes = new Map([[root.id, { depth: 0, path: '', hasChildren: true, mode: 'root' }]]), siblingNames = new Map();
  try {
    if (!Array.isArray(rows)) return incomplete();
    for (const row of rows) {
      // Validate the native pre-order ancestry and names before selecting only direct named members.
      if (!row || row.kind !== 'child' || !Number.isSafeInteger(row.depth) || row.depth < 1 || typeof row.hasChildren !== 'boolean'
        || !['continuable', 'external', 'one-shot'].includes(row.mode) || !['running', 'inactive'].includes(row.activity)
        || typeof row.id !== 'string' || !ID.test(row.id) || nodes.has(row.id)) return incomplete();
      const parent = nodes.get(row.parentId);
      if (!parent || row.depth !== parent.depth + 1 || !parent.hasChildren || parent.mode === 'external') return incomplete();
      if (row.name !== undefined && !roleName(row.name)) return incomplete();
      const expectedPath = parent.path === undefined || row.name === undefined ? undefined
        : parent.path === '' ? row.name : `${parent.path}/${row.name}`;
      if (row.path !== expectedPath) return incomplete();
      if (row.name !== undefined) {
        const names = siblingNames.get(row.parentId) ?? new Set();
        if (names.has(row.name)) return incomplete();
        names.add(row.name); siblingNames.set(row.parentId, names);
      }
      nodes.set(row.id, { depth: row.depth, path: row.path, hasChildren: row.hasChildren, mode: row.mode });
      if (row.depth !== 1) continue;
      // The catalog explicitly records no direct name. Preserve the foreign id without inventing a role name.
      if (row.name === undefined) { anonymousForeignIds.push(row.id); continue; }
      catalog.push({ id: row.id, name: row.name, ...(typeof row.label === 'string' ? { description: row.label } : {}) });
    }
  } catch { return unavailable(); }
  try {
    const members = [];
    for (const member of catalog) {
      signal.throwIfAborted(); members.push(await observeLive(ctx, root, member, signal));
    }
    signal.throwIfAborted();
    return { complete: true, members, anonymousForeignIds, reason: 'NATIVE_CATALOG_COMPLETE' };
  } catch { return unavailable(); }
}

/** Return only this registration's disposers. Native Preset mount readiness and lifetime remain authoritative. */
export async function registerLauncherPresets(ctx, config, spec, nativeControlEntry) {
  const control = checkedControlEntry(nativeControlEntry);
  const owner = config?.ownedSessionId;
  if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(owner)
    || !Array.isArray(spec?.members) || spec.members.length === 0 || typeof ctx.agentPresets?.register !== 'function') fail('LAUNCHER_PRESET_INPUT_INVALID');
  const ids = new Set(), names = new Set();
  const roles = spec.members.map(member => {
    if (!member || !roleName(member.name) || names.has(member.name) || typeof member.agentPreset !== 'string'
      || !ID.test(member.agentPreset) || ids.has(member.agentPreset) || !text(member.personaPrompt, 16384)
      || member.personaPrompt.includes('\0') || !validRoleToolList(member.nativeToolAllowlist)) fail('LAUNCHER_PRESET_INPUT_INVALID');
    const tools = [...member.nativeToolAllowlist];
    ids.add(member.agentPreset); names.add(member.name);
    return { preset: member.agentPreset, role: member.name, persona: member.personaPrompt, tools };
  });
  const disposers = [];
  try {
    for (const role of roles) {
      const dispose = await ctx.agentPresets.register({ id: role.preset, name: `Launcher role ${role.role}`, plugins: [
        { id: `${role.preset}-native-control`, name: control.name, config: { interrupt: false } },
        { id: `${role.preset}-persona`, name: 'dsh-subagent-live-rc2-local/launcher-role',
          config: { ownedSessionId: owner, roleName: role.role, personaPrompt: role.persona, tools: [...role.tools] } },
      ] });
      if (typeof dispose !== 'function') fail('LAUNCHER_PRESET_REGISTRATION_FAILED');
      disposers.push(dispose);
    }
    return disposers;
  } catch {
    let cleanupFailed = false;
    for (const dispose of disposers.reverse()) { try { await dispose(); } catch { cleanupFailed = true; } }
    throw new LauncherNativeError('LAUNCHER_PRESET_REGISTRATION_FAILED', cleanupFailed);
  }
}

/** Construct a native tool call only. Explicit caller input is never replaced with a model or prompt default. */
export function makeLauncherSpawnCall(member, { workspace, prompt } = {}) {
  if (!member || !roleName(member.name) || !text(member.description, 200) || !text(member.provider, 200)
    || member.provider.trim() !== member.provider || !text(member.model, 200) || member.model.trim() !== member.model
    || !text(member.reasoningEffort, 200) || member.reasoningEffort.trim() !== member.reasoningEffort
    || typeof member.agentPreset !== 'string'
    || !ID.test(member.agentPreset) || typeof workspace !== 'string' || !isAbsolute(workspace) || !text(prompt, 8000)) fail('LAUNCHER_SPAWN_INPUT_INVALID');
  return { type: 'tool-call', id: `dsh-team-launcher-${randomUUID()}`, name: SPAWN,
    arguments: JSON.stringify({ name: member.name, description: member.description, cwd: workspace,
      provider: member.provider, model: member.model, reasoning_effort: member.reasoningEffort,
      agent_preset: member.agentPreset, prompt }) };
}

/** Activation admission is not a child-result or collaboration-success receipt. */
export function parseLauncherSpawnBatch(batch, call, member) {
  if (!call || call.type !== 'tool-call' || call.name !== SPAWN || typeof call.id !== 'string' || !ID.test(call.id)
    || !member || !roleName(member.name)) fail('LAUNCHER_SPAWN_INPUT_INVALID');
  const diagnostic = delegationFailure(batch, { callId: call.id }, member.name, member.name);
  return diagnostic ? { ok: false, code: 'NATIVE_DELEGATION_FAILED', delegationFailure: diagnostic }
    : { ok: true, activation: { kind: 'activation', name: member.name }, callId: call.id };
}
