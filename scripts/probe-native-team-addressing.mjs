/** Physical native ToolsService/control/scope probe for stable team role addressing. */
import assert from 'node:assert/strict';
import { nativeAgentRows } from './native-host-contract.mjs';
import { describeNativeError } from './native-error.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plugin = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtime = resolve(process.argv[2] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh');
const receipt = resolve(process.argv[4] ?? 'native-team-addressing.json');
const sourceHead = process.argv[5] ?? 'working-tree';
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, toolsModule, { NativeToolExecutor }, scopeApi, { AgentRegistry },
  { SessionProjectionRegistry }, controlModule, taskModule, { SubagentRuntime }, { Session }] = await Promise.all([
  load('cordis'), load('dsh-tools'), load('dsh-tool-executor-native'), load('dsh-scope'), load('dsh-agent'),
  load('dsh-session-projection'), load('dsh-tool-subagent-control'), load('dsh-tool-agent-team'),
  load('dsh-subagent'), load('dsh-session'),
]);
const fromPlugin = path => import(pathToFileURL(join(plugin, path)).href);
const [{ installRootAddressing, isReusableLogicalTeamTaskDelegate, mountLogicalNativeControl,
  registerReusableLogicalTeamTaskDelegate }, replacement, { REPLACEMENT_OWNER }] = await Promise.all([
  fromPlugin('src/team-addressing.js'), fromPlugin('src/member-replacement.js'), fromPlugin('src/replacement-store.js'),
]);
const { ToolsService } = toolsModule;
const version = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version;
const { createHostAdapter } = await fromPlugin('src/host-adapter.js');
const host = { controlModule, taskModule, scopeApi, adapter: createHostAdapter({ version, Context }) };
const ROOT = 'session-address-native-root';
const OLD_IMPLEMENTER = '11111111-1111-4111-8111-111111111111';
const OLD_REVIEWER = '22222222-2222-4222-8222-222222222222';
const signal = AbortSignal.timeout(20_000);
const modelSelection = { provider: 'isolated-address-probe', model: 'no-provider-call' };
const PRESET_CONTROL_NAMES = ['list_agents', 'send_message', 'wait_agent'];
const TASK_TOOLS = ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'];
const ROOT_ADDRESS_INJECT = [
  'tools', 'subagents', 'settings', 'agentTeams', 'systemPrompt', 'agents', 'agentPresets',
];
const CORDIS_ORIGINAL = Symbol.for('cordis.original');
const CORDIS_TRACKER = Symbol.for('cordis.tracker');

function markTraceableService(ctx, name, service) {
  Object.defineProperties(service, {
    ctx: { value: ctx, writable: true },
    [CORDIS_TRACKER]: { value: Object.freeze({ associate: name, property: 'ctx' }) },
  });
  return service;
}

const originalService = value => value?.[CORDIS_ORIGINAL] ?? value;

async function installCapacityRuntime(ctx, scopes) {
  if (version !== '0.2.3-alpha.2') return undefined;
  ctx.provide('workingDirectory', { get: () => process.cwd() });
  // Capacity comes from the Host's real manager/pool. The catalog/delivery fixture
  // remains controlled, but never invents running/limit for the new native tool.
  const scope = ctx.isolate('subagents').plugin(SubagentRuntime, { maxActiveSubagents: 7 });
  await scope; scopes.push(scope);
  return scope.ctx.subagents;
}

async function installFromInjectedOwner(ctx, root, name, host) {
  const owner = ctx.plugin({ name, inject: ROOT_ADDRESS_INJECT, async apply(inner) {
    await installRootAddressing(inner, root, host);
  } });
  try { await owner; }
  catch (error) { await owner.dispose(); throw error; }
  return owner;
}

async function installToolsHost(ctx, name) {
  const host = ctx.plugin({ name, inject: ['systemPrompt'], apply(inner) {
    new ToolsService(inner);
    inner.tools.setExecutor(new NativeToolExecutor(inner));
  } });
  try { await host; }
  catch (error) { await host.dispose(); throw error; }
  return host;
}

async function injectedHarness(ctx, name) {
  const harness = ctx.plugin({ name, inject: ROOT_ADDRESS_INJECT, apply() {} });
  try { await harness; }
  catch (error) { await harness.dispose(); throw error; }
  return harness;
}

const replacementRequest = role => ({ role, provider: 'fixture-provider', model: 'fixture-model',
  reasoningEffort: 'max', personaPrompt: `Act as ${role}.`, prompt: `Start as ${role}.`,
  tools: ['team_task_get', 'team_task_update', 'send_message'], progressFacts: 'No prior progress.' });
function begin(record, role, oldChildId, instanceName, at) {
  return replacement.startReplacement(record, { role, oldChildId, handoffDigest: 'c'.repeat(64), taskRefs: [],
    handoffText: `handoff ${role}`, candidateConfig: JSON.stringify(replacementRequest(role)), instanceName }, at);
}
function move(record, operationId, phase, at) {
  const operation = record.operations.find(entry => entry.id === operationId);
  if (phase === 'standby') return replacement.transitionReplacement(record, operationId, phase, at,
    { newChildId: replacement.replacementCandidateOf(operation).childId });
  if (phase === 'ready') return replacement.transitionReplacement(record, operationId, phase, at, { readinessAck: {
    senderSessionId: operation.newChildId, handoffDigest: operation.handoffDigest,
    configDigest: operation.configDigest, at } });
  if (phase === 'active') return replacement.transitionReplacement(record, operationId, phase, at,
    { takeoverProof: { kind: 'not-required', reason: 'no-unfinished-tasks', at } });
  return replacement.transitionReplacement(record, operationId, phase, at);
}
function activate(record, operationId, startAt) {
  let at = startAt;
  for (const phase of ['standby', 'ready', 'transferring', 'activating', 'active']) {
    record = move(record, operationId, phase, at++);
  }
  return record;
}
function finishStandby(record, operationId, startAt) {
  let at = startAt;
  for (const phase of ['ready', 'transferring', 'activating', 'active']) record = move(record, operationId, phase, at++);
  return record;
}

let record = replacement.readReplacementRecord();
const first = begin(record, 'implementer', OLD_IMPLEMENTER, 'implementer-r2', 1);
record = activate(first.record, first.operationId, 2);
const firstId = replacement.currentRoleOwner(record, 'implementer');
const second = begin(record, 'implementer', firstId, 'implementer-r3', 10);
let standby = move(second.record, second.operationId, 'standby', 11);
const secondId = standby.operations.at(-1).newChildId;
const activeSecond = finishStandby(standby, second.operationId, 12);

const catalog = [
  { kind: 'child', id: OLD_IMPLEMENTER, parentId: ROOT, depth: 1, path: 'implementer', name: 'implementer',
    mode: 'continuable', label: 'old implementer', activity: 'inactive', hasChildren: false },
  { kind: 'child', id: OLD_REVIEWER, parentId: ROOT, depth: 1, path: 'reviewer', name: 'reviewer',
    mode: 'continuable', label: 'reviewer', activity: 'inactive', hasChildren: false },
  { kind: 'child', id: firstId, parentId: ROOT, depth: 1, path: 'implementer-r2', name: 'implementer-r2',
    mode: 'continuable', label: 'first replacement', activity: 'inactive', hasChildren: false },
  { kind: 'child', id: secondId, parentId: ROOT, depth: 1, path: 'implementer-r3', name: 'implementer-r3',
    mode: 'continuable', label: 'second replacement', activity: 'inactive', hasChildren: false },
];

async function runGeneration(initialRecord, label,
  compositionModule = '@deepseek-ai/dsh-tool-subagent-control') {
  const ctx = new Context(), scopes = [], registrations = [], deliveries = [], interruptions = [], resolutions = [];
  let stored = initialRecord;
  const visibleCatalog = () => {
    const admitted = new Set([OLD_IMPLEMENTER, OLD_REVIEWER]);
    for (const operation of stored.operations) if (operation.newChildId !== null) admitted.add(operation.newChildId);
    return catalog.filter(entry => admitted.has(entry.id));
  };
  ctx.provide('settings', { describe: () => [{ ns: REPLACEMENT_OWNER, revision: 1,
    value: { replacementRecords: { [ROOT]: stored } } }] });
  ctx.provide('systemPrompt', { tools() { return () => {}; }, context() { return () => {}; },
    section() { return () => {}; }, getContextOrder() { return 1; }, getSectionOrder() { return 1; } });
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  const capacityRuntime = await installCapacityRuntime(ctx, scopes);
  scopes.push(await installToolsHost(ctx, `address-tools-${label}`));
  const root = { id: ROOT, status: 'idle', session: new Session(ROOT, []) };
  const agents = new Map([[ROOT, root]]);
  let storedTask = { id: 'task-address-1', revision: 1, subject: 'Address the current role',
    description: 'Keep logical task ownership stable.', status: 'in_progress', ownerId: firstId,
    ownerName: 'implementer-r2', blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] };
  const taskCalls = [];
  let teamEnabled = true;
  const nativeSubagents = markTraceableService(ctx, 'subagents', {
    ...(capacityRuntime ? { capacityOf: agent => capacityRuntime.capacityOf(agent) } : {}),
    rootOf(agent) { if (agents.get(agent?.id) !== agent) throw new Error('UNAUTHORIZED'); return root; },
    namesOf(agent) {
      if (agent === root) return { self: 'lead' };
      const row = catalog.find(entry => entry.id === agent.id);
      if (!row) throw new Error('UNAUTHORIZED');
      return { self: row.path, parent: 'lead' };
    },
    async resolveName(agent, name, nextSignal) {
      assert.equal(originalService(this), nativeSubagents); assert.equal(this.rootOf(agent), root); nextSignal.throwIfAborted();
      resolutions.push(name);
      if (name === 'lead') return ROOT;
      const row = visibleCatalog().find(entry => entry.path === name);
      if (row) return row.id;
      if (name.includes('/')) throw Object.assign(new Error('AGENT_NAME_NOT_FOUND'), { code: 'AGENT_NAME_NOT_FOUND' });
      return name;
    },
    async listDescendants(rootId, nextSignal) {
      assert.equal(originalService(this), nativeSubagents); assert.equal(rootId, ROOT); nextSignal.throwIfAborted();
      return structuredClone(visibleCatalog());
    },
    async sendMessage(sender, targetId, content, options) {
      assert.equal(originalService(this), nativeSubagents); assert.equal(this.rootOf(sender), root); options.signal.throwIfAborted();
      if (sender.id === targetId || ![ROOT, ...visibleCatalog().map(entry => entry.id)].includes(targetId)) {
        throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      }
      deliveries.push({ sender: sender.id, targetId, content: structuredClone(content) });
      return `message-${deliveries.length}`;
    },
    interrupt(targetId, authority) {
      assert.equal(originalService(this), nativeSubagents); assert.equal(authority.kind, 'ancestor'); assert.equal(authority.agent, root);
      if (!visibleCatalog().some(entry => entry.id === targetId)) throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      interruptions.push(targetId);
    },
  });
  ctx.provide('subagents', nativeSubagents);
  const nativeTeams = markTraceableService(ctx, 'agentTeams', {
    isEnabled(caller) { assert.equal(nativeSubagents.rootOf(caller), root); return teamEnabled; },
    createTask(caller, request) {
      assert.equal(nativeSubagents.rootOf(caller), root); taskCalls.push({ kind: 'create', request });
      return Promise.resolve(structuredClone(storedTask));
    },
    getTask(caller, taskId) {
      assert.equal(nativeSubagents.rootOf(caller), root); assert.equal(taskId, storedTask.id);
      taskCalls.push({ kind: 'get', taskId }); return structuredClone(storedTask);
    },
    listTasks(caller) {
      assert.equal(nativeSubagents.rootOf(caller), root); taskCalls.push({ kind: 'list' });
      return [structuredClone(storedTask)];
    },
    async updateTask(caller, request, nextSignal) {
      assert.equal(nativeSubagents.rootOf(caller), root); nextSignal.throwIfAborted();
      taskCalls.push({ kind: 'update', request: structuredClone(request) });
      if (request.expectedRevision !== storedTask.revision) throw new Error('TEAM_TASK_STALE_REVISION');
      if (request.action === 'reassign') {
        const row = visibleCatalog().find(entry => entry.id === request.owner);
        assert.ok(row); storedTask = { ...storedTask, ownerId: row.id, ownerName: row.path,
          revision: storedTask.revision + 1 };
      }
      return structuredClone(storedTask);
    },
  });
  ctx.provide('agentTeams', nativeTeams);
  const presetKey = {};
  ctx.provide('agentPresets', { inspectCompositions(agentCtx) {
    assert.equal(scopeApi.scopeParentOf(scopeApi.scopeOf(agentCtx)), presetKey);
    return [{ id: 'standard', leakedServices: [], modules: [{
      moduleName: compositionModule, useHostBase: true,
    }] }];
  } });
  const harness = await injectedHarness(ctx, `address-harness-${label}`); scopes.push(harness);
  const access = harness.ctx;
  const preset = scopeApi.createScope(access, presetKey); scopes.push(preset);
  const presetControl = preset.ctx.plugin(controlModule, { interrupt: false });
  scopes.push(presetControl); await presetControl;
  const presetControlDefinitions = new Map(PRESET_CONTROL_NAMES
    .map(name => [name, access.tools.get(name, presetKey)]));
  const rootScope = scopeApi.createScope(access, root, { parent: presetKey }); scopes.push(rootScope); root.ctx = rootScope.ctx;
  registrations.push(await access.agents.register(root));
  for (const row of catalog) {
    const agent = { id: row.id, status: 'idle', session: { id: row.id, header: { origin: 'subagent', parentSession: ROOT } } };
    const childScope = scopeApi.createScope(access, agent); scopes.push(childScope); agent.ctx = childScope.ctx;
    agents.set(agent.id, agent); registrations.push(await access.agents.register(agent));
  }
  const dispose = async () => {
    for (const unregister of registrations.reverse()) await unregister();
    for (const scope of scopes.reverse()) await scope.dispose();
    await ctx.fiber.dispose();
  };
  try {
    scopes.push(await installFromInjectedOwner(ctx, root, `address-owner-${label}`,
      host));
  } catch (error) {
    await dispose();
    throw error;
  }
  let callSeq = 0;
  async function callWithToolSet(agent, name, args, toolSet) {
    const batch = await access.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call',
      id: `${label}-${++callSeq}`, name, arguments: JSON.stringify(args) }] });
    return batch.results[0].result;
  }
  async function call(agent, name, args) {
    const toolSet = await access.tools.resolve({ agent, modelSelection, signal });
    try { return await callWithToolSet(agent, name, args, toolSet); }
    finally { toolSet.dispose(); }
  }
  async function addRoleControl(agent, roleRecord) {
    const roleKey = {}, rolePreset = scopeApi.createScope(access, roleKey); scopes.push(rolePreset);
    await mountLogicalNativeControl(rolePreset.ctx, { fixedRootId: ROOT, interrupt: false }, { controlModule, scopeApi });
    for (const name of TASK_TOOLS) {
      const definition = access.tools.get(name, root);
      assert.equal(definition?.name, name);
      assert.equal(isReusableLogicalTeamTaskDelegate(definition), true);
      registerReusableLogicalTeamTaskDelegate(rolePreset.ctx, definition);
    }
    const existing = scopes.find(scope => scopeApi.scopeOf(scope.ctx) === agent);
    assert.ok(existing); await existing.dispose();
    const roleScope = scopeApi.createScope(access, agent, { parent: roleKey }); scopes.push(roleScope); agent.ctx = roleScope.ctx;
    agent.ctx.tools.restrict({ allow: ['send_message', 'team_task_list'] });
    stored = roleRecord;
  }
  return { ctx: access, root, agents, nativeSubagents, deliveries, interruptions, resolutions, taskCalls,
    call, callWithToolSet, addRoleControl,
    presetControlDefinitions,
    task: () => structuredClone(storedTask), dispose,
    setRecord(value) { stored = value; }, setTeamEnabled(value) { teamEnabled = value; } };
}

async function runSharedPresetLifecycle() {
  const ctx = new Context(), scopes = [], registrations = [], deliveries = [];
  const roots = [
    { id: 'session-address-shared-root-a', status: 'idle', session: new Session('session-address-shared-root-a', []) },
    { id: 'session-address-shared-root-b', status: 'idle', session: new Session('session-address-shared-root-b', []) },
  ];
  const oldIds = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const records = {}, catalogs = new Map(), rootByAgentId = new Map();
  for (let index = 0; index < roots.length; index++) {
    const started = begin(replacement.readReplacementRecord(), 'implementer', oldIds[index], 'implementer-r2', index * 10 + 1);
    const active = activate(started.record, started.operationId, index * 10 + 2);
    const current = replacement.currentRoleOwner(active, 'implementer');
    records[roots[index].id] = active;
    catalogs.set(roots[index].id, [
      { kind: 'child', id: oldIds[index], parentId: roots[index].id, depth: 1,
        path: 'implementer', name: 'implementer', mode: 'continuable', label: 'retired',
        activity: 'inactive', hasChildren: false },
      { kind: 'child', id: current, parentId: roots[index].id, depth: 1,
        path: 'implementer-r2', name: 'implementer-r2', mode: 'continuable', label: 'current',
        activity: 'inactive', hasChildren: false },
    ]);
    rootByAgentId.set(roots[index].id, roots[index]);
    rootByAgentId.set(oldIds[index], roots[index]);
    rootByAgentId.set(current, roots[index]);
  }
  ctx.provide('settings', { describe: () => [{ ns: REPLACEMENT_OWNER, revision: 1,
    value: { replacementRecords: records } }] });
  ctx.provide('systemPrompt', { tools() { return () => {}; }, context() { return () => {}; },
    section() { return () => {}; }, getContextOrder() { return 1; }, getSectionOrder() { return 1; } });
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  const capacityRuntime = await installCapacityRuntime(ctx, scopes);
  scopes.push(await installToolsHost(ctx, 'shared-address-tools'));
  const nativeSubagents = markTraceableService(ctx, 'subagents', {
    ...(capacityRuntime ? { capacityOf: agent => capacityRuntime.capacityOf(agent) } : {}),
    rootOf(agent) {
      const root = rootByAgentId.get(agent?.id);
      if (root === undefined) throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      return root;
    },
    namesOf(agent) {
      const root = this.rootOf(agent);
      if (agent === root) return { self: 'lead' };
      const row = catalogs.get(root.id).find(entry => entry.id === agent.id);
      if (!row) throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      return { self: row.path, parent: 'lead' };
    },
    async resolveName(agent, name, nextSignal) {
      const root = this.rootOf(agent); nextSignal.throwIfAborted();
      if (name === 'lead') return root.id;
      const row = catalogs.get(root.id).find(entry => entry.path === name);
      if (row) return row.id;
      if (name.includes('/')) throw Object.assign(new Error('AGENT_NAME_NOT_FOUND'), { code: 'AGENT_NAME_NOT_FOUND' });
      return name;
    },
    async listDescendants(rootId, nextSignal) {
      nextSignal.throwIfAborted();
      return structuredClone(catalogs.get(rootId) ?? []);
    },
    async sendMessage(sender, targetId, content, options) {
      const root = this.rootOf(sender); options.signal.throwIfAborted();
      if (!catalogs.get(root.id).some(entry => entry.id === targetId)) {
        throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      }
      deliveries.push({ rootId: root.id, sender: sender.id, targetId, content: structuredClone(content) });
      return `shared-message-${deliveries.length}`;
    },
    interrupt() {},
  });
  ctx.provide('subagents', nativeSubagents);
  const nativeTeams = markTraceableService(ctx, 'agentTeams', {
    isEnabled(agent) { nativeSubagents.rootOf(agent); return true; },
    async createTask() { return { id: 'shared-task', revision: 1, ownerId: null, ownerName: null }; },
    getTask() { return { id: 'shared-task', revision: 1, ownerId: null, ownerName: null }; },
    listTasks() { return []; },
    async updateTask() { return { id: 'shared-task', revision: 1, ownerId: null, ownerName: null }; },
  });
  ctx.provide('agentTeams', nativeTeams);
  const presetKey = {};
  ctx.provide('agentPresets', { inspectCompositions(agentCtx) {
    assert.equal(scopeApi.scopeParentOf(scopeApi.scopeOf(agentCtx)), presetKey);
    return [{ id: 'standard', leakedServices: [], modules: [{
      moduleName: '@deepseek-ai/dsh-tool-subagent-control', useHostBase: true,
    }] }];
  } });
  const harness = await injectedHarness(ctx, 'shared-address-harness'); scopes.push(harness);
  const access = harness.ctx;
  const preset = scopeApi.createScope(access, presetKey); scopes.push(preset);
  const presetControl = preset.ctx.plugin(controlModule, { interrupt: false });
  scopes.push(presetControl); await presetControl;
  for (const root of roots) {
    const rootScope = scopeApi.createScope(access, root, { parent: presetKey });
    scopes.push(rootScope); root.ctx = rootScope.ctx;
    registrations.push(await access.agents.register(root));
  }
  let callSeq = 0;
  async function call(agent, message) {
    const toolSet = await access.tools.resolve({ agent, modelSelection, signal });
    try {
      const batch = await access.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call',
        id: `shared-${++callSeq}`, name: 'send_message', arguments: JSON.stringify({ agent: 'implementer', message }) }] });
      return batch.results[0].result;
    } finally { toolSet.dispose(); }
  }
  const owners = [];
  async function install(root) {
    const owner = await installFromInjectedOwner(ctx, root, `shared-address-owner-${owners.length}`,
      host);
    owners.push(owner);
    return owner;
  }
  async function dispose() {
    for (const owner of owners.reverse()) await owner.dispose();
    for (const unregister of registrations.reverse()) await unregister();
    for (const scope of scopes.reverse()) await scope.dispose();
    await ctx.fiber.dispose();
  }
  return { roots, records, catalogs, deliveries, call, install, dispose };
}

const checks = [];
const check = (name, evidence = {}) => checks.push({ name, passed: true, ...evidence });
const failureProbe = process.argv[6];
let failureStage = 'setup', setupError, cleanupError;
async function disposeFixture(value) {
  const previous = failureStage; failureStage = 'cleanup';
  await value?.dispose();
  if (failureProbe === '--cleanup-failure') assert.fail('Injected fixture teardown assertion');
  failureStage = previous;
}
async function runChecks() {
let fixture;
try {
  if (failureProbe === '--setup-failure') assert.fail('Injected fixture initialization assertion');
  fixture = await runGeneration(record, 'first');
  failureStage = 'checks';
  if (failureProbe === '--assertion-failure') assert.fail('Injected early addressing business assertion');
  assert.equal(await fixture.nativeSubagents.resolveName(fixture.root, 'implementer', signal), OLD_IMPLEMENTER);
  const sentFirst = await fixture.call(fixture.root, 'send_message', { agent: 'implementer', message: 'first' });
  assert.equal(sentFirst.isError, false, JSON.stringify(sentFirst));
  assert.equal(fixture.deliveries.at(-1).targetId, firstId);
  const listedFirst = await fixture.call(fixture.root, 'list_agents', {});
  assert.equal(listedFirst.isError, false, JSON.stringify(listedFirst));
  assert.ok(nativeAgentRows(listedFirst.value).some(entry => entry.name === 'implementer'));
  assert.ok(!nativeAgentRows(listedFirst.value).some(entry => /implementer-r[23]/.test(entry.name)));
  if (version === '0.2.3-alpha.2') {
    const capacity = fixture.nativeSubagents.capacityOf(fixture.root);
    assert.deepEqual({ running: listedFirst.value.running, limit: listedFirst.value.limit }, capacity);
    assert.notEqual(capacity.running, nativeAgentRows(listedFirst.value).length);
  }
  check('first replacement keeps raw catalog unchanged while native send and list use the stable logical role');

  for (const [name, definition] of fixture.presetControlDefinitions) {
    assert.equal(fixture.ctx.tools.get(name, fixture.root), definition);
  }
  check('official Standard Preset control definitions remain the exact executable definitions under logical addressing');

  const nativeSendDefinition = fixture.presetControlDefinitions.get('send_message');
  const unknownSendDefinition = onCall => Object.freeze({ ...nativeSendDefinition, async execute(args, exec) {
    onCall(args); return nativeSendDefinition.execute(args, exec);
  } });
  let shadowCalls = 0, shadowTarget;
  let removeShadow = fixture.root.ctx.tools.register(unknownSendDefinition(args => {
    shadowCalls++; shadowTarget = args.agent;
  }));
  const shadowed = await fixture.call(fixture.root, 'send_message', {
    agent: 'implementer', message: 'unknown definition before resolve',
  });
  assert.equal(shadowed.isError, true, JSON.stringify(shadowed));
  assert.equal(shadowCalls, 0); assert.equal(shadowTarget, undefined);
  removeShadow();

  const oldToolSet = await fixture.ctx.tools.resolve({ agent: fixture.root, modelSelection, signal });
  removeShadow = fixture.root.ctx.tools.register(unknownSendDefinition(() => { shadowCalls++; }));
  try {
    const stale = await fixture.callWithToolSet(fixture.root, 'send_message', {
      agent: 'implementer', message: 'unknown definition after resolve',
    }, oldToolSet);
    assert.equal(stale.isError, true, JSON.stringify(stale));
    assert.equal(shadowCalls, 0);
  } finally {
    removeShadow(); oldToolSet.dispose();
  }
  check('logical bridging refuses a late Agent-local control definition before rewriting arguments or invoking its body');

  const tasksFirst = await fixture.call(fixture.root, 'team_task_list', { owner: 'implementer' });
  assert.equal(tasksFirst.isError, false, JSON.stringify(tasksFirst));
  assert.equal(tasksFirst.value.tasks[0].owner, 'implementer');
  check('the unmodified native task list resolves and renders the first logical owner');

  const taskDelegate = fixture.ctx.tools.get('team_task_list', fixture.root);
  assert.equal(isReusableLogicalTeamTaskDelegate(taskDelegate), true);
  assert.equal(isReusableLogicalTeamTaskDelegate({ ...taskDelegate }), false);
  assert.throws(() => registerReusableLogicalTeamTaskDelegate(fixture.root.ctx, { ...taskDelegate }),
    { code: 'TEAM_ADDRESS_NATIVE_CONTROL_UNAVAILABLE' });
  check('only the exact frozen logical task delegate exposes its original conditional reuse contract');

  const oldSend = await fixture.call(fixture.root, 'send_message', { agent: OLD_IMPLEMENTER, message: 'forbidden' });
  const oldName = await fixture.call(fixture.root, 'send_message', { agent: 'implementer-r2', message: 'forbidden' });
  assert.equal(oldSend.isError, true); assert.equal(oldName.isError, true);
  check('historical physical name and retired Session id are rejected before native delivery');

  fixture.setRecord(standby);
  const candidate = fixture.agents.get(secondId);
  await fixture.addRoleControl(candidate, standby);
  const ack = await fixture.call(candidate, 'send_message', { agent: 'lead', message: '{"ready":true}' });
  assert.equal(ack.isError, false, JSON.stringify(ack)); assert.equal(fixture.deliveries.at(-1).targetId, ROOT);
  const business = await fixture.call(candidate, 'send_message', { agent: 'implementer', message: 'forbidden' });
  assert.equal(business.isError, true);
  const listedStandby = await fixture.call(fixture.root, 'list_agents', {});
  assert.ok(!nativeAgentRows(listedStandby.value).some(entry => entry.name === 'implementer'));
  const frozenTask = fixture.task();
  const standbyReassign = await fixture.call(fixture.root, 'team_task_update', {
    task_id: frozenTask.id, expected_revision: frozenTask.revision, action: 'reassign', owner: 'implementer',
  });
  assert.equal(standbyReassign.isError, true); assert.deepEqual(fixture.task(), frozenTask);
  check('Standby lead ACK remains native while the frozen business role fails closed in send and list');

  fixture.setRecord(activeSecond);
  const sentSecond = await fixture.call(fixture.root, 'send_message', { agent: 'implementer', message: 'second' });
  assert.equal(sentSecond.isError, false, JSON.stringify(sentSecond));
  assert.equal(fixture.deliveries.at(-1).targetId, secondId);
  const interrupted = await fixture.call(fixture.root, 'interrupt_agent', { agent: 'implementer' });
  assert.equal(interrupted.isError, false, JSON.stringify(interrupted)); assert.equal(fixture.interruptions.at(-1), secondId);
  assert.equal((await fixture.call(fixture.root, 'interrupt_agent', { agent: firstId })).isError, true);
  check('second replacement routes native send and interrupt to the new current Session only');

  const beforeTask = fixture.task();
  const reassigned = await fixture.call(fixture.root, 'team_task_update', {
    task_id: beforeTask.id, expected_revision: beforeTask.revision, action: 'reassign', owner: 'implementer',
  });
  assert.equal(reassigned.isError, false, JSON.stringify(reassigned));
  assert.equal(fixture.task().ownerId, secondId); assert.equal(reassigned.value.owner, 'implementer');
  assert.equal(fixture.taskCalls.at(-1).request.owner, secondId);
  const peerTasks = await fixture.call(fixture.agents.get(secondId), 'team_task_list', { owner: 'implementer' });
  assert.equal(peerTasks.isError, false, JSON.stringify(peerTasks));
  assert.equal(peerTasks.value.tasks[0].owner, 'implementer');
  const taskCallsAfterReassign = fixture.taskCalls.length;
  assert.equal((await fixture.call(fixture.root, 'team_task_update', {
    task_id: beforeTask.id, expected_revision: beforeTask.revision + 1, action: 'reassign', owner: firstId,
  })).isError, true);
  assert.equal((await fixture.call(fixture.root, 'team_task_update', {
    task_id: beforeTask.id, expected_revision: beforeTask.revision + 1, action: 'reassign', owner: 'implementer-r2',
  })).isError, true);
  assert.equal(fixture.taskCalls.length, taskCallsAfterReassign);
  check('native task owner input and output follow the second logical generation and reject retired ids');

  const beforeMask = fixture.deliveries.length;
  const deny = fixture.root.ctx.tools.restrict({ deny: ['send_message'] });
  assert.equal((await fixture.call(fixture.root, 'send_message', { agent: 'implementer', message: 'masked' })).isError, true);
  assert.equal(fixture.deliveries.length, beforeMask); deny();
  const beforeTaskMask = fixture.taskCalls.length;
  const denyTask = fixture.root.ctx.tools.restrict({ deny: ['team_task_update'] });
  assert.equal((await fixture.call(fixture.root, 'team_task_update', {
    task_id: fixture.task().id, expected_revision: fixture.task().revision,
    action: 'reassign', owner: 'implementer',
  })).isError, true);
  assert.equal(fixture.taskCalls.length, beforeTaskMask); denyTask();
  fixture.setTeamEnabled(false);
  assert.equal((await fixture.call(fixture.root, 'team_task_list', {})).isError, true);
  assert.equal((await fixture.call(fixture.agents.get(secondId), 'team_task_list', {})).isError, true);
  assert.equal(fixture.taskCalls.length, beforeTaskMask); fixture.setTeamEnabled(true);
  let approvalCalls = 0, approvalDeny, approvalTool;
  let approve = () => {
    approvalDeny = fixture.root.ctx.tools.restrict({ deny: [approvalTool] }); return 'allowed-once';
  };
  fixture.ctx.provide('approval', { async request() { approvalCalls++; return approve(); } });
  const ask = fixture.root.ctx.on('tools/pre-execute', (exec, next) => {
    if (!['send_message', 'team_task_update'].includes(exec.name)) return next();
    approvalTool = exec.name; return { kind: 'ask' };
  });
  assert.equal((await fixture.call(fixture.root, 'send_message', { agent: 'implementer', message: 'approval-race' })).isError, true);
  assert.equal(approvalCalls, 1); assert.equal(fixture.deliveries.length, beforeMask);
  approvalDeny();
  assert.equal((await fixture.call(fixture.root, 'team_task_update', {
    task_id: fixture.task().id, expected_revision: fixture.task().revision,
    action: 'reassign', owner: 'implementer',
  })).isError, true);
  assert.equal(approvalCalls, 2); assert.equal(fixture.taskCalls.length, beforeTaskMask);
  approvalDeny();

  let approvalShadowCalls = 0, approvalShadowRemove;
  approve = () => {
    approvalShadowRemove = fixture.root.ctx.tools.register(unknownSendDefinition(() => { approvalShadowCalls++; }));
    return 'allowed-once';
  };
  const approvalShadowed = await fixture.call(fixture.root, 'send_message', {
    agent: 'implementer', message: 'unknown definition during approval',
  });
  assert.equal(approvalShadowed.isError, true, JSON.stringify(approvalShadowed));
  assert.equal(approvalShadowCalls, 0); approvalShadowRemove();

  approve = () => {
    const remove = fixture.root.ctx.tools.register(unknownSendDefinition(() => { approvalShadowCalls++; }));
    remove(); return 'allowed-once';
  };
  const approvalRestored = await fixture.call(fixture.root, 'send_message', {
    agent: 'implementer', message: 'official definition restored after approval',
  });
  assert.equal(approvalRestored.isError, false, JSON.stringify(approvalRestored));
  assert.equal(approvalShadowCalls, 0); assert.equal(fixture.deliveries.at(-1).targetId, secondId);
  ask();
  check('native conditions, Agent-scope masks, definition replacement and post-approval revocation stop unverified bodies');
} finally {
  await disposeFixture(fixture);
}

failureStage = 'setup';
fixture = await runGeneration(activeSecond, 'reload');
failureStage = 'checks';
try {
  const reloaded = await fixture.call(fixture.root, 'send_message', { agent: 'implementer', message: 'after reload' });
  assert.equal(reloaded.isError, false, JSON.stringify(reloaded));
  assert.equal(fixture.deliveries.at(-1).targetId, secondId);
  const names = nativeAgentRows((await fixture.call(fixture.root, 'list_agents', {})).value).map(entry => entry.name);
  assert.ok(names.includes('implementer')); assert.ok(!names.some(name => /implementer-r[23]/.test(name)));
  check('fresh native scope reload reads the durable second-generation mapping without respawn or catalog mutation');
} finally {
  await disposeFixture(fixture);
}

if (failureProbe === '--nested-io-failure') {
  await assert.rejects(Promise.reject(Object.assign(new Error('Injected native fixture IO denial'), { code: 'EPERM' })),
    { code: 'TEAM_ADDRESS_LAYER_OCCUPIED' });
}
await assert.rejects(runGeneration(activeSecond, 'unproven-control', 'fixture/unproven-control'),
  { code: 'TEAM_ADDRESS_LAYER_OCCUPIED' });
check('a Preset-scoped control remains occupied unless the Registry proves the official native module');

failureStage = 'setup';
fixture = await runSharedPresetLifecycle();
failureStage = 'checks';
try {
  const firstOwner = await fixture.install(fixture.roots[0]);
  const secondOwner = await fixture.install(fixture.roots[1]);
  assert.equal((await fixture.call(fixture.roots[0], 'root a')).isError, false);
  assert.equal((await fixture.call(fixture.roots[1], 'root b')).isError, false);
  const secondCurrent = replacement.currentRoleOwner(fixture.records[fixture.roots[1].id], 'implementer');
  assert.equal(fixture.deliveries.at(-1).targetId, secondCurrent);
  await firstOwner.dispose();
  const retained = await fixture.call(fixture.roots[1], 'root b after root a unload');
  assert.equal(retained.isError, false, JSON.stringify(retained));
  assert.equal(fixture.deliveries.at(-1).targetId, secondCurrent);
  check('two live roots sharing one Preset retain logical addressing when the first plugin owner unloads');

  await secondOwner.dispose();
  const reinstalledOwner = await fixture.install(fixture.roots[0]);
  const reinstalled = await fixture.call(fixture.roots[0], 'same root after plugin remount');
  assert.equal(reinstalled.isError, false, JSON.stringify(reinstalled));
  const firstCurrent = replacement.currentRoleOwner(fixture.records[fixture.roots[0].id], 'implementer');
  assert.equal(fixture.deliveries.at(-1).targetId, firstCurrent);
  await reinstalledOwner.dispose();
  check('one live root and Preset generation can unload and reinstall the addressing plugin');
} finally {
  await disposeFixture(fixture);
}
}

try { await runChecks(); }
catch (error) {
  const described = describeNativeError(error);
  checks.push({ name: 'native logical addressing failure', passed: false, error: described });
  if (failureStage === 'setup') setupError = described;
  if (failureStage === 'cleanup') cleanupError = described;
}

const hashes = {};
for (const name of ['src/team-addressing.js', 'role-control.js', 'src/launcher-native.js', 'src/team-host.js']) {
  hashes[name] = createHash('sha256').update(await readFile(join(plugin, name))).digest('hex');
}
const result = { sourceHead, runtime, passed: checks.length === 14 && checks.every(item => item.passed), hashes, checks, setupError, cleanupError,
  boundary: 'Physical pinned Host Cordis, dsh-scope, ToolsService, NativeToolExecutor and an official-Standard-equivalent Preset scope mounting unmodified dsh-tool-subagent-control (interrupt false), plus unmodified dsh-tool-agent-team definitions. Isolated in-memory Settings/AgentRegistry, catalog and task-board service; no user profile, Host daemon, model, network, manager mutation or persistent Session.' };
await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.passed) process.exitCode = 1;
