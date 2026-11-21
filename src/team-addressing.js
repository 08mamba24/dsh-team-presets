import { readReplacementRecord, replacementCandidateOf } from './member-replacement.js';
import { readReplacementRow } from './replacement-store.js';
import { nativeRoleControlFromHost } from './team-host.js';

export const LOGICAL_TEAM_ROLES = Object.freeze(['implementer', 'reviewer']);

class TeamAddressingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TeamAddressingError';
    this.code = code;
  }
}

const fail = code => { throw new TeamAddressingError(code); };
const hasPathPrefix = (value, prefix) => value === prefix || value.startsWith(`${prefix}/`);
const suffixAfter = (value, prefix) => value === prefix ? '' : value.slice(prefix.length + 1);
const CORDIS_ORIGINAL = Symbol.for('cordis.original');
const CORDIS_TRACKER = Symbol.for('cordis.tracker');

// Each Cordis service read can return a fresh traceable use-site proxy.  The
// public original symbol is the stable Host-owned identity behind those views;
// plain fixture/service objects fall back to their own reference.
function serviceIdentity(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
  return value[CORDIS_ORIGINAL] ?? value;
}

const sameService = (left, right) => serviceIdentity(left) === serviceIdentity(right);

function roleState(record, role) {
  const operations = record.operations.filter(operation => operation.role === role);
  if (operations.length === 0) {
    return { role, mode: 'native', physicalNames: new Set(), retiredIds: new Set() };
  }
  let currentId;
  let currentName = role;
  const physicalNames = new Set([role]);
  const seenIds = new Set();
  for (const operation of operations) {
    currentId ??= operation.oldChildId;
    seenIds.add(operation.oldChildId);
    if (operation.newChildId !== null) seenIds.add(operation.newChildId);
    if (operation.candidateConfig !== undefined) seenIds.add(replacementCandidateOf(operation).childId);
    if (operation.instanceName !== undefined) physicalNames.add(operation.instanceName);
    if (operation.phase === 'active') {
      currentId = operation.newChildId;
      currentName = operation.instanceName;
    }
  }
  const latest = operations.at(-1);
  const terminal = latest.phase === 'active' || latest.phase === 'aborted';
  // Older records may have reached `active` without persisting the physical
  // instance name.  The Session id alone can address the role itself, but it
  // cannot preserve descendant paths or catalog projection.  Treat that
  // incomplete managed coordinate as unavailable instead of guessing a name.
  const addressable = terminal && typeof currentId === 'string'
    && typeof currentName === 'string' && currentName.length > 0;
  const retiredIds = new Set(seenIds);
  if (addressable && currentId !== undefined) retiredIds.delete(currentId);
  return {
    role,
    mode: addressable ? 'addressable' : 'unavailable',
    currentId,
    currentName,
    physicalNames,
    retiredIds,
  };
}

function statesOf(value) {
  const record = readReplacementRecord(value);
  return LOGICAL_TEAM_ROLES.map(role => roleState(record, role));
}

function recordAccess(nativeSubagents, { readRecord, fixedRootId, assertCurrent } = {}) {
  if (!nativeSubagents || typeof nativeSubagents.rootOf !== 'function' || typeof readRecord !== 'function') {
    fail('TEAM_ADDRESS_HOST_UNAVAILABLE');
  }
  const current = () => {
    if (assertCurrent !== undefined && !sameService(assertCurrent(), nativeSubagents)) {
      fail('TEAM_ADDRESS_HOST_CHANGED');
    }
  };
  const recordForRoot = rootId => {
    current();
    if (fixedRootId !== undefined && rootId !== fixedRootId) fail('TEAM_ADDRESS_WRONG_ROOT');
    return readReplacementRecord(readRecord(rootId));
  };
  const recordForCaller = caller => {
    current();
    const root = nativeSubagents.rootOf(caller);
    return { root, record: recordForRoot(root.id) };
  };
  return { current, recordForRoot, recordForCaller };
}

function projectionFor(states, name) {
  for (const state of states) {
    if (state.mode === 'native') continue;
    let matched;
    for (const physical of state.physicalNames) {
      if (hasPathPrefix(name, physical)
        && (matched === undefined || physical.length > matched.length)) matched = physical;
    }
    if (matched === undefined) continue;
    if (state.mode !== 'addressable' || matched !== state.currentName) return { managed: true };
    const suffix = suffixAfter(name, matched);
    return { managed: true, name: suffix === '' ? state.role : `${state.role}/${suffix}` };
  }
  return { managed: false, name };
}

/** Resolve a model-visible stable role/path to the current native identity. */
export function resolveLogicalTeamTarget(value, target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 512 || target.includes('\0')) {
    fail('TEAM_ADDRESS_INVALID');
  }
  const states = statesOf(value);
  for (const state of states) {
    if (!hasPathPrefix(target, state.role)) continue;
    if (state.mode === 'native') return target;
    if (state.mode !== 'addressable') fail('TEAM_ROLE_ADDRESS_UNAVAILABLE');
    const suffix = suffixAfter(target, state.role);
    if (suffix === '') return state.currentId;
    if (typeof state.currentName !== 'string' || state.currentName.length === 0) {
      fail('TEAM_ROLE_ADDRESS_UNAVAILABLE');
    }
    return `${state.currentName}/${suffix}`;
  }
  for (const state of states) {
    if (state.retiredIds.has(target)) fail('TEAM_MEMBER_RETIRED');
    for (const name of state.physicalNames) {
      if (name !== state.role && hasPathPrefix(target, name)) fail('TEAM_PHYSICAL_ADDRESS_FORBIDDEN');
    }
    if (state.mode !== 'addressable' && target === state.currentId) fail('TEAM_MEMBER_RETIRED');
  }
  return target;
}

/** Project the append-only native catalog onto stable logical role paths. */
export function projectLogicalTeamAgents(value, entries) {
  if (!Array.isArray(entries)) fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
  const states = statesOf(value);
  const projected = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') {
      fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
    }
    const projection = projectionFor(states, entry.name);
    if (!projection.managed) projected.push(entry);
    else if (projection.name !== undefined) projected.push({ ...entry, name: projection.name });
  }
  return projected;
}

/** Project native descendant rows before the original list_agents body renders them. */
export function projectLogicalTeamDescendants(value, entries) {
  if (!Array.isArray(entries)) fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
  const states = statesOf(value);
  const projected = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.id !== 'string' || (entry.path !== undefined && typeof entry.path !== 'string')) {
      fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
    }
    const retired = states.some(state => state.retiredIds.has(entry.id)
      || (state.mode !== 'addressable' && state.currentId === entry.id));
    if (retired) continue;
    if (entry.path === undefined) {
      projected.push(entry);
      continue;
    }
    const projection = projectionFor(states, entry.path);
    if (!projection.managed) projected.push(entry);
    else if (projection.name !== undefined) {
      const slash = projection.name.lastIndexOf('/');
      projected.push({ ...entry, path: projection.name,
        ...(entry.name === undefined ? {} : { name: slash < 0 ? projection.name : projection.name.slice(slash + 1) }) });
    }
  }
  return projected;
}

/** Project only an active member's self/parent label; Standby identity stays physical for ACK. */
export function projectLogicalTeamName(value, name) {
  if (typeof name !== 'string') fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
  const projection = projectionFor(statesOf(value), name);
  return projection.name ?? name;
}

/**
 * Isolated subagent-service view used only by the original native control plugin.
 * Native delivery, interruption, authorization and lifecycle methods stay bound
 * to the original service; only model-facing names/catalog rows are projected.
 */
export function createLogicalSubagents(nativeSubagents, { readRecord, fixedRootId, assertCurrent } = {}) {
  if (!nativeSubagents || typeof nativeSubagents.resolveName !== 'function' || typeof nativeSubagents.listDescendants !== 'function'
    || typeof nativeSubagents.namesOf !== 'function' || typeof readRecord !== 'function') {
    fail('TEAM_ADDRESS_HOST_UNAVAILABLE');
  }
  const { current, recordForRoot, recordForCaller } = recordAccess(nativeSubagents,
    { readRecord, fixedRootId, assertCurrent });
  const bound = new Map();
  return new Proxy(Object.create(null), {
    get(_target, property) {
      // This facade is a distinct isolated service view.  Forwarding Cordis'
      // tracker would make getTraceable wrap it as the original Service and
      // read native prototype methods without entering this proxy's traps.
      if (property === CORDIS_TRACKER || property === CORDIS_ORIGINAL) return undefined;
      if (property === 'resolveName') return async (caller, name, signal) => {
        const { record } = recordForCaller(caller);
        return nativeSubagents.resolveName(caller, resolveLogicalTeamTarget(record, name), signal);
      };
      if (property === 'listDescendants') return async (rootId, signal) => {
        current();
        const record = recordForRoot(rootId);
        return projectLogicalTeamDescendants(record, await nativeSubagents.listDescendants(rootId, signal));
      };
      if (property === 'namesOf') return agent => {
        const { record } = recordForCaller(agent);
        const names = nativeSubagents.namesOf(agent);
        return {
          self: projectLogicalTeamName(record, names.self),
          ...(names.parent === undefined ? {} : { parent: projectLogicalTeamName(record, names.parent) }),
        };
      };
      const value = Reflect.get(nativeSubagents, property, nativeSubagents);
      if (typeof value !== 'function') return value;
      let callable = bound.get(value);
      if (callable === undefined) {
        callable = value.bind(nativeSubagents);
        bound.set(value, callable);
      }
      return callable;
    },
  });
}

function logicalTaskOwner(states, task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
  if (task.ownerId === undefined) return task;
  if (typeof task.ownerId !== 'string'
    || (task.ownerName !== undefined && typeof task.ownerName !== 'string')) {
    fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
  }
  for (const state of states) {
    if (state.currentId === task.ownerId || state.retiredIds.has(task.ownerId)) {
      return { ...task, ownerName: state.role };
    }
  }
  if (task.ownerName === undefined) return task;
  let matched;
  for (const state of states) {
    for (const physical of state.physicalNames) {
      if (hasPathPrefix(task.ownerName, physical)
        && (matched === undefined || physical.length > matched.physical.length)) matched = { state, physical };
    }
  }
  if (matched === undefined) return task;
  const suffix = suffixAfter(task.ownerName, matched.physical);
  return { ...task, ownerName: suffix === '' ? matched.state.role : `${matched.state.role}/${suffix}` };
}

/** Isolated Team-service view that only normalizes model-visible owner names. */
export function createLogicalAgentTeams(nativeAgentTeams, nativeSubagents,
  { readRecord, fixedRootId, assertCurrent, assertSubagentsCurrent } = {}) {
  const methods = ['isEnabled', 'createTask', 'getTask', 'listTasks', 'updateTask'];
  if (!nativeAgentTeams || methods.some(method => typeof nativeAgentTeams[method] !== 'function')) {
    fail('TEAM_ADDRESS_HOST_UNAVAILABLE');
  }
  const { recordForCaller } = recordAccess(nativeSubagents,
    { readRecord, fixedRootId, assertCurrent: assertSubagentsCurrent });
  const current = () => {
    if (assertCurrent !== undefined && !sameService(assertCurrent(), nativeAgentTeams)) {
      fail('TEAM_ADDRESS_HOST_CHANGED');
    }
  };
  const project = (caller, task) => {
    current();
    return logicalTaskOwner(statesOf(recordForCaller(caller).record), task);
  };
  const bound = new Map();
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === CORDIS_TRACKER || property === CORDIS_ORIGINAL) return undefined;
      if (property === 'createTask' || property === 'updateTask') return async (caller, ...args) => {
        current();
        return project(caller, await nativeAgentTeams[property](caller, ...args));
      };
      if (property === 'getTask') return (caller, ...args) => {
        current();
        return project(caller, nativeAgentTeams.getTask(caller, ...args));
      };
      if (property === 'listTasks') return caller => {
        current();
        const tasks = nativeAgentTeams.listTasks(caller);
        if (!Array.isArray(tasks)) fail('TEAM_ADDRESS_NATIVE_RESULT_INVALID');
        return tasks.map(task => project(caller, task));
      };
      const value = Reflect.get(nativeAgentTeams, property, nativeAgentTeams);
      if (typeof value !== 'function') return value;
      let callable = bound.get(value);
      if (callable === undefined) {
        callable = (...args) => { current(); return value.apply(nativeAgentTeams, args); };
        bound.set(value, callable);
      }
      return callable;
    },
  });
}

const CONTROL_NAMES = Object.freeze(['list_agents', 'send_message', 'wait_agent']);
const TASK_NAMES = Object.freeze(['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']);
const reusableLogicalTeamTaskDelegates = new WeakMap();

/** True only for the exact task delegate minted by this addressing module. */
export function isReusableLogicalTeamTaskDelegate(definition) {
  return definition !== null && (typeof definition === 'object' || typeof definition === 'function')
    && reusableLogicalTeamTaskDelegates.has(definition);
}

/**
 * Re-register one exact delegate with its original Team-mode activation.
 * The private activation remains step-visible here, while the frozen delegate
 * repeats the same check in its body. Lookalike or copied definitions fail.
 */
export function registerReusableLogicalTeamTaskDelegate(ctx, definition) {
  if (!ctx || typeof ctx.tools?.register !== 'function') fail('TEAM_ADDRESS_NATIVE_CONTROL_UNAVAILABLE');
  const when = isReusableLogicalTeamTaskDelegate(definition)
    ? reusableLogicalTeamTaskDelegates.get(definition) : undefined;
  if (typeof when !== 'function') fail('TEAM_ADDRESS_NATIVE_CONTROL_UNAVAILABLE');
  return ctx.tools.register(definition, { when });
}

function nativeTeamEnabled(nativeAgentTeams, agent) {
  if (agent === undefined) return false;
  try { return nativeAgentTeams.isEnabled(agent) === true; }
  catch (error) {
    if (error?.name === 'SubagentError' && error.code === 'UNAUTHORIZED') return false;
    throw error;
  }
}

function delegatedTaskDefinition(definition, active) {
  if (!definition || typeof definition !== 'object' || typeof definition.execute !== 'function') {
    fail('TEAM_ADDRESS_NATIVE_CONTROL_UNAVAILABLE');
  }
  const descriptors = Object.getOwnPropertyDescriptors(definition);
  const original = descriptors.execute;
  if (!original || typeof original.value !== 'function') fail('TEAM_ADDRESS_NATIVE_CONTROL_UNAVAILABLE');
  descriptors.execute = { configurable: original.configurable, enumerable: original.enumerable,
    writable: original.writable, value: async (args, exec) => {
      if (!active(exec?.agent)) fail('TEAM_TASKS_UNAVAILABLE');
      return definition.execute(args, exec);
    } };
  return Object.freeze(Object.create(Object.getPrototypeOf(definition), descriptors));
}

const scopeParentBindings = new WeakMap();

function bindOwnedScopeParent(scopeApi, key, parent) {
  const previous = scopeApi.scopeParentOf(key);
  let owned = scopeParentBindings.get(key);
  if (owned === undefined) {
    const binding = scopeApi.bindScopeParent(key, parent);
    if (!binding || typeof binding.rebind !== 'function') fail('TEAM_ADDRESS_HOST_CONTRACT_UNAVAILABLE');
    owned = { scopeApi, binding, current: parent, active: true };
    scopeParentBindings.set(key, owned);
  } else {
    if (owned.scopeApi !== scopeApi || owned.active) fail('TEAM_ADDRESS_LAYER_OCCUPIED');
    owned.binding.rebind(parent);
    owned.current = parent;
    owned.active = true;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (!owned.active || owned.current !== parent) return;
    // dsh-scope intentionally keeps parent keys bound after fiber disposal;
    // only the original binding may safely restore and later re-link this key.
    owned.binding.rebind(previous);
    owned.current = previous;
    owned.active = false;
  };
}

/** Mount the physical native control module against an isolated logical-name view. */
export async function mountLogicalNativeControl(ctx, { fixedRootId, interrupt = false, tasks = false } = {}, host) {
  if (!ctx || typeof ctx.isolate !== 'function' || typeof ctx.provide !== 'function'
    || typeof ctx.plugin !== 'function' || typeof ctx.get !== 'function' || typeof ctx.effect !== 'function'
    || typeof ctx.tools?.get !== 'function' || typeof host?.controlModule?.apply !== 'function'
    || (tasks && typeof host?.taskModule?.apply !== 'function')
    || typeof host?.scopeApi?.scopeOf !== 'function' || typeof host.scopeApi.createScope !== 'function'
    || typeof host.scopeApi.bindScopeParent !== 'function'
    || typeof host.scopeApi.scopeParentOf !== 'function') fail('TEAM_ADDRESS_HOST_UNAVAILABLE');
  const key = host.scopeApi.scopeOf(ctx);
  if (key === undefined) fail('TEAM_ADDRESS_SCOPE_UNAVAILABLE');
  const nativeSubagents = ctx.get('subagents'), settings = ctx.get('settings');
  const nativeAgentTeams = tasks ? ctx.get('agentTeams') : undefined;
  const logicalSubagents = createLogicalSubagents(nativeSubagents, {
    fixedRootId,
    readRecord(rootId) {
      return readReplacementRow(settings, rootId, { requirePartition: fixedRootId !== undefined }).value;
    },
    assertCurrent: () => ctx.get('subagents'),
  });
  const logicalAgentTeams = tasks ? createLogicalAgentTeams(nativeAgentTeams, nativeSubagents, {
    fixedRootId,
    readRecord(rootId) {
      return readReplacementRow(settings, rootId, { requirePartition: fixedRootId !== undefined }).value;
    },
    assertCurrent: () => ctx.get('agentTeams'),
    assertSubagentsCurrent: () => ctx.get('subagents'),
  }) : undefined;
  // A Loader row calls this while its own fiber is still initializing. Publish
  // the isolated service from a settled backing scope, then make that scope the
  // Preset's public ancestor. Providing into the initializing row itself leaves
  // the native control injection pending and publishes no tool definitions.
  const nativeKey = {}, nativeScope = host.scopeApi.createScope(ctx, nativeKey);
  await nativeScope.ctx.fiber;
  let delegateScope, isolated;
  const names = [...(interrupt ? [...CONTROL_NAMES, 'interrupt_agent'] : CONTROL_NAMES),
    ...(tasks ? TASK_NAMES : [])];
  const before = new Map(names.map(name => [name, ctx.tools.get(name, key)]));
  const fibers = [], releases = [];
  try {
    let parentKey = nativeKey;
    if (tasks) {
      const delegateKey = {};
      delegateScope = host.scopeApi.createScope(nativeScope.ctx, delegateKey, { parent: nativeKey });
      await delegateScope.ctx.fiber;
      parentKey = delegateKey;
    }
    const restoreParent = bindOwnedScopeParent(host.scopeApi, key, parentKey);
    releases.push(ctx.effect(() => restoreParent, 'dsh-team-address-parent'));
    isolated = nativeScope.ctx.isolate('subagents');
    if (tasks) isolated = isolated.isolate('agentTeams');
    releases.push(isolated.provide('subagents', logicalSubagents));
    if (tasks) releases.push(isolated.provide('agentTeams', logicalAgentTeams));
    fibers.push(isolated.plugin(host.controlModule, { interrupt }));
    await fibers.at(-1);
    if (tasks) {
      fibers.push(isolated.plugin(host.taskModule, {}));
      await fibers.at(-1);
      // The physical Team plugin owns schemas, rendering, CAS and bodies.  Its
      // private `when` registration is not part of ToolDefinition, so publish
      // a thin delegate whose exact reuse contract carries that predicate into
      // a role Preset and repeats it inside the body too.
      // Agent scopes remain below this ancestor and retain final masks/guards.
      for (const name of TASK_NAMES) {
        const definition = ctx.tools.get(name, key);
        const active = agent => {
          if (!sameService(ctx.get('agentTeams'), nativeAgentTeams)) fail('TEAM_ADDRESS_HOST_CHANGED');
          return nativeTeamEnabled(nativeAgentTeams, agent);
        };
        const delegated = delegatedTaskDefinition(definition, active);
        const when = ({ agent }) => active(agent);
        reusableLogicalTeamTaskDelegates.set(delegated, when);
        releases.push(delegateScope.ctx.tools.register(delegated, { when }));
      }
    }
    for (const name of names) {
      const definition = ctx.tools.get(name, key);
      if (!definition || definition.name !== name || definition === before.get(name)) {
        fail('TEAM_ADDRESS_NATIVE_CONTROL_UNAVAILABLE');
      }
    }
  } catch (error) {
    for (const fiber of fibers.reverse()) {
      try { await fiber?.dispose(); } catch { /* Preserve the admission failure. */ }
    }
    for (const release of releases.reverse()) {
      try { await release(); } catch { /* Preserve the admission failure. */ }
    }
    try { await delegateScope?.dispose(); } catch { /* Preserve the admission failure. */ }
    try { await nativeScope.dispose(); } catch { /* Preserve the admission failure. */ }
    throw error;
  }
}

const rootInstalls = new WeakMap();
const ROOT_ADDRESS_INJECT = Object.freeze([
  'tools', 'subagents', 'agents', 'systemPrompt', 'agentTeams', 'settings',
]);

function startRootInstall(ctx, presetKey, host) {
  const entry = { owners: new WeakSet(), refs: 0, addon: undefined, layer: undefined, disposing: undefined };
  entry.install = (async () => {
    const addon = ctx.root.plugin({ name: 'dsh-team-root-addressing', inject: ROOT_ADDRESS_INJECT,
      async apply(injected) {
        for (const name of [...CONTROL_NAMES, 'interrupt_agent', ...TASK_NAMES]) {
          if (injected.tools.get(name, presetKey) !== injected.tools.get(name)) {
            fail('TEAM_ADDRESS_LAYER_OCCUPIED');
          }
        }
        const layer = host.scopeApi.createScope(injected, presetKey);
        entry.layer = layer;
        try {
          await mountLogicalNativeControl(layer.ctx, { interrupt: true, tasks: true }, host);
        } catch (error) {
          await layer.dispose();
          throw error;
        }
      } });
    entry.addon = addon;
    try {
      await addon;
    } catch (error) {
      await addon.dispose();
      throw error;
    }
  })();
  rootInstalls.set(presetKey, entry);
  entry.install.catch(() => {
    if (rootInstalls.get(presetKey) === entry) rootInstalls.delete(presetKey);
  });
  return entry;
}

async function releaseRootInstall(presetKey, entry, ctx) {
  if (!entry.owners.delete(ctx)) return;
  entry.refs--;
  if (entry.refs !== 0) return;
  entry.disposing ??= (async () => {
    try { await entry.install; } catch { return; }
    await entry.addon?.dispose();
  })().finally(() => {
    if (rootInstalls.get(presetKey) === entry) rootInstalls.delete(presetKey);
  });
  await entry.disposing;
}

/**
 * Install one generic logical-name layer on the root Agent's shared Preset.
 * The layer derives the caller's root for every invocation, so one retained
 * Preset generation safely serves multiple independent current-team roots.
 */
export async function installRootAddressing(ctx, agent, host) {
  host ??= await nativeRoleControlFromHost();
  if (!agent?.ctx || !ctx?.root || typeof ctx.root.plugin !== 'function'
    || typeof ctx.effect !== 'function' || typeof ctx.tools?.get !== 'function'
    || typeof host?.scopeApi?.scopeOf !== 'function'
    || typeof host.scopeApi.scopeParentOf !== 'function' || typeof host.scopeApi.createScope !== 'function') {
    fail('TEAM_ADDRESS_HOST_UNAVAILABLE');
  }
  const agentKey = host.scopeApi.scopeOf(agent.ctx);
  const presetKey = agentKey === undefined ? undefined : host.scopeApi.scopeParentOf(agentKey);
  if (agentKey !== agent || presetKey === undefined) fail('TEAM_ADDRESS_SCOPE_UNAVAILABLE');
  let entry = rootInstalls.get(presetKey);
  if (entry?.disposing !== undefined) {
    await entry.disposing;
    entry = rootInstalls.get(presetKey);
  }
  entry ??= startRootInstall(ctx, presetKey, host);
  if (!entry.owners.has(ctx)) {
    entry.owners.add(ctx);
    entry.refs++;
    try {
      ctx.effect(() => async () => releaseRootInstall(presetKey, entry, ctx), 'dsh-team-root-addressing');
    } catch (error) {
      await releaseRootInstall(presetKey, entry, ctx);
      throw error;
    }
  }
  await entry.install;
}
