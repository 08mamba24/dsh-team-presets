import { bindRc5Fixture } from './fixtures/host-contract.mjs';
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
// This fixture drives the historical file-bound entry and its POSIX marker checks.
// Windows current-session and control-entry tests run in their dedicated suites.
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' ? 'Legacy macOS file-bound entry' : false }, fn);
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTeam } from '../src/team-driver.js';
import { TEAM_ROLE_TOOLS } from '../src/team-config.js';
import { CONTROL_ENTRY } from './fixtures/control-entry.mjs';

// Synthetic native Host, task CAS and event contracts; this does not start Desktop or a provider.
async function fixture(t, options = {}) {
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const policyEntered = deferred(), policyReady = deferred(), childrenReady = deferred(), creationEntered = deferred(), creationReady = deferred(), latePublished = deferred(), activationRejected = deferred();
  const enableEntered = deferred(), enableReady = deferred();
  const commandController = new AbortController();
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-live-team-')));
  let liveWorkspace = workspace;
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = { mode: 'team', ownedSessionId: 'session-20000000-0000-4000-8000-000000000001', workspace,
    // A setup deadline of 20ms can fire before either child is published under
    // parallel npm packing. Keep enough setup time to test the actual drain.
    runTag: 'live-team-test', timeoutMs: 1000,
    roles: Object.fromEntries(['implementer', 'reviewer'].map((role, i) => [role, {
      memberName: `live-test-${role}`, presetId: `dsh-live-test-${role}`, personaNonce: `persona-test-${role}-abc123`,
      maxStreams: i === 0 ? 6 : 5, route: { provider: 'deepseek-account', model: i === 0 ? 'deepseek-flash' : 'deepseek-v4-pro', reasoningEffort: 'low', maxTokens: 1024 },
    }])) };
  await writeFile(join(workspace, '.dsh-team-live.json'), JSON.stringify({ purpose: 'dsh-native-team-pair', ownedSessionId: config.ownedSessionId, runTag: config.runTag }), { mode: 0o600 });
  const commands = new Map(), hooks = new Map(), agents = new Map(), effects = [], tasks = new Map(), order = [], presets = new Map();
  let mounted = false, disposals = 0, interrupts = 0, unregisters = 0, mutations = 0, createAttempts = 0, foreignAdded = false;
  let attackBodies = 0, unrelatedPasses = 0, providerCalls = 0;
  let policyCalls = 0, pausedBodyCalls = 0;
  for (const task of options.initialTasks ?? []) tasks.set(task.id, structuredClone(task));
  if (options.attack) tasks.set('foreign', { id: 'foreign', revision: 1, status: 'pending', subject: 'other task', description: 'private other task content', blockedBy: [], writeScopes: [] });
  let releaseMessage;
  const messageReady = new Promise(resolve => { releaseMessage = resolve; });
  const childRecords = new Map();
  const on = (map, name, fn) => { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(fn); return () => map.get(name).delete(fn); };
  const emit = (name, ...args) => { for (const fn of hooks.get(name) ?? []) fn(...args); };
  const root = { id: config.ownedSessionId, session: { id: config.ownedSessionId, header: { cwd: workspace } },
    status: 'idle', model: { current: () => config.roles.implementer.route }, ctx: {},
    inbox: { nextStep: [], nextTurn: [], remove(id) { const i = this.nextTurn.findIndex(m => m.id === id); if (i < 0) return false; this.nextTurn.splice(i, 1); return true; } },
    async runMaintenance(fn) { assert.equal(this.status, 'idle'); order.push('maintenance-enter'); try { return await fn(new AbortController().signal); } finally { order.push('maintenance-exit'); } },
    async whenIdle() {},
  };
  agents.set(root.id, root);
  let teamEnabled = options.teamAlreadyEnabled === true;
  let teamModeSaved = options.teamAlreadyEnabled !== undefined || (options.initialTasks?.length ?? 0) > 0;
  let enableWasPaused = false;
  const taskView = task => ({ ...structuredClone(task), ready: task.status === 'pending' && task.blockedBy.every(id => tasks.get(id).status === 'completed'), writeScopeWarnings: [] });
  // Native TeamTaskBoard.state gates every board operation, including read-only get/list.
  const requireEnabled = method => {
    order.push(`board:${method}`);
    if (!teamEnabled) throw Object.assign(new Error('enable Agent Teams for this Session before using the task board'), { code: 'TEAM_DISABLED' });
  };
  const projectedTasks = () => [...tasks.values()].filter(task => task.status !== 'deleted').map(taskView);
  const team = {
    isEnabled: () => teamEnabled,
    async setEnabled(agent, value) {
      assert.equal(agent, root); teamEnabled = value; teamModeSaved = true; mutations++; order.push(`team:${value}`);
      if (options.pauseEnable && value && !enableWasPaused) { enableWasPaused = true; enableEntered.resolve(); await enableReady.promise; }
    },
    async createTask(agent, spec) {
      assert.equal(agent, root); requireEnabled('createTask'); createAttempts++;
      const task = { id: String(createAttempts), revision: 1, status: 'pending', blockedBy: [], writeScopes: [], ...spec };
      tasks.set(task.id, task); mutations++; order.push(`create-task:${task.id}`);
      if (options.persistenceFailure && createAttempts === 2) throw Object.assign(new Error('synthetic uncertain persistence'), { code: 'TEAM_TASK_PERSISTENCE_UNCONFIRMED' });
      if (options.foreignBoard && createAttempts === 1) tasks.set('foreign', { id: 'foreign', revision: 1, status: 'pending', subject: 'other task', description: 'other work', blockedBy: [], writeScopes: [] });
      if (options.foreignMode && createAttempts === 1) { teamEnabled = false; order.push('external-mode:false'); }
      return taskView(task);
    },
    getTask(_agent, id) {
      requireEnabled('getTask');
      const task = tasks.get(id);
      if (!task) throw Object.assign(new Error(`team task "${id}" not found`), { code: 'TEAM_TASK_NOT_FOUND' });
      return taskView(task);
    },
    listTasks() { requireEnabled('listTasks'); return projectedTasks(); },
  };
  function update(child, args) {
    requireEnabled('updateTask');
    assert.notEqual(child, root, 'the driver must never impersonate a child task owner');
    const task = tasks.get(args.task_id); assert.ok(task); assert.equal(task.revision, args.expected_revision, 'native task CAS');
    if (args.action === 'claim') {
      assert.equal(taskView(task).ready, true); assert.equal(task.ownerId, undefined);
      task.ownerId = child.id; task.status = 'in_progress';
    } else {
      assert.equal(task.ownerId, child.id); assert.equal(task.status, 'in_progress');
      if (args.action === 'edit') task.description = args.description;
      else { assert.equal(args.action, 'complete'); task.status = 'completed'; }
    }
    task.revision++; return taskView(task);
  }
  const native = { apply() {} };
  async function spawn(input) {
    await options.nativePreflight?.();
    assert.equal(input.agent, root); assert.equal(input.calls.length, 1); assert.equal(input.calls[0].name, 'dsh_live_team_spawn');
    const args = JSON.parse(input.calls[0].arguments), role = Object.keys(config.roles).find(r => config.roles[r].memberName === args.name);
    order.push(`spawn:${role}`);
    if (options.nativeBatch && role === 'reviewer') return options.nativeBatch({ callId: input.calls[0].id, memberName: args.name });
    if (options.failImplementer && role === 'implementer') {
      activationRejected.resolve(); return { results: [{ callId: input.calls[0].id, result: { isError: true } }], additionalContexts: [], concluded: false };
    }
    if (options.lateStart && role === 'reviewer') { creationEntered.resolve(); await creationReady.promise; }
    const binding = config.roles[role], localHooks = new Map(), finalGuards = new Set();
    assert.equal(args.agent_preset, binding.presetId); assert.equal(args.provider, binding.route.provider); assert.equal(args.model, binding.route.model);
    assert.ok(!args.prompt.includes(binding.personaNonce));
    const child = { id: `child-${role}`, session: { id: `child-${role}`, header: { origin: 'subagent', parentSession: root.id } },
      ctx: { preset: binding.presetId, on: (name, fn) => on(localHooks, name, fn),
        tools: { guard(fn) { finalGuards.add(fn); return () => finalGuards.delete(fn); } } },
      model: { current: () => binding.route }, options: { maxTokens: 1024 } };
    agents.set(child.id, child);
    const childEmit = (name, ...values) => { for (const fn of localHooks.get(name) ?? []) fn(...values); };
    let toolCount = 0, ended = false, interrupted = false, pendingImplementerEnd;
    const toolController = new AbortController();
    function finish(stopReason = 'completed') {
      if (ended) return; ended = true;
      if (role === 'implementer' && options.badOutput && stopReason === 'completed') {
        ended = false; pendingImplementerEnd = stopReason; return;
      }
      publishEnd(stopReason);
    }
    function publishEnd(stopReason) {
      ended = true;
      if (role === 'reviewer' && stopReason === 'completed' && options.ownTaskConflict) {
        const implementation = tasks.get('1');
        if (options.ownTaskConflict === 'owner') implementation.ownerId = 'foreign-child';
        if (options.ownTaskConflict === 'revision') implementation.revision++;
        if (options.ownTaskConflict === 'scope') implementation.writeScopes = ['foreign-scope'];
      }
      const output = { role, personaNonce: binding.personaNonce, value: 5, completedTaskIds: [role === 'implementer' ? '1' : '2'],
        ...(role === 'reviewer' ? { reviewedTaskId: '1', verdict: 'approved' } : {}) };
      if (role === 'implementer' && options.badOutput === 'nonce') output.personaNonce = 'wrong-persona';
      root.inbox.nextTurn.push({ id: `notice-${role}`, source: { kind: 'subagent-settled', senderSessionId: child.id } });
      if (options.foreignInbox && !foreignAdded) { foreignAdded = true; root.inbox.nextTurn.push({ id: 'foreign-input', source: { kind: 'user' } }); }
      order.push(`end:${role}`);
      emit('subagent/end', { id: child.id, runId: `run-${role}`, provider: 'spawn', parentSessionId: root.id, local: true,
        stopReason: role === 'implementer' && options.badOutput === 'end' ? 'error' : stopReason,
        lastAssistantMessage: [{ type: 'text', text: role === 'implementer' && options.badOutput === 'json' ? '{broken-json' : JSON.stringify(output) }] });
      if (role === 'reviewer' && options.badOutput) childRecords.get('child-implementer')?.publishPending();
    }
    const record = { finish, publishPending() { if (pendingImplementerEnd && !ended) publishEnd(pendingImplementerEnd); },
      interrupt() { interrupted = true; toolController.abort(); }, role, child };
    childRecords.set(child.id, record);
    if (childRecords.size === 2) childrenReady.resolve();
    async function tool(name, args, execute) {
      const callId = `call-${role}-${++toolCount}`;
      childEmit('session/event', child.session, { type: 'tool/call', data: { name, callId, arguments: JSON.stringify(args) } });
      const listeners = [...localHooks.get('tools/pre-execute') ?? []];
      const exec = { agent: child, name, callId, arguments: Object.freeze({ ...args }), signal: toolController.signal };
      const pauseHere = options.policy?.role === role && options.policy.name === name
        && (!options.policy.action || options.policy.action === args.action);
      const downstream = async () => {
        if (!pauseHere) return { kind: 'allow' };
        policyCalls++;
        if (options.policy.phase === 'next') { policyEntered.resolve(); await policyReady.promise; }
        return { kind: options.policy.phase === 'ask' ? 'ask' : options.policy.decision ?? 'allow' };
      };
      const decisionAt = i => i === listeners.length ? downstream() : listeners[i](exec, () => decisionAt(i + 1));
      let decision = await decisionAt(0);
      // The real native pipeline awaits approval after the pre-execute waterfall, then runs final policy guards.
      if (decision.kind === 'ask') { policyEntered.resolve(); await policyReady.promise; decision = { kind: options.policy.decision ?? 'allow' }; }
      if (decision.kind === 'allow') {
        for (const guard of finalGuards) {
          const denied = guard(exec);
          if (denied) { decision = { kind: 'deny', ...denied }; break; }
        }
      }
      if (decision.kind !== 'allow') {
        childEmit('session/event', child.session, { type: 'tool/result', data: { message: { toolCallId: callId, isError: true } } });
        throw Object.assign(new Error(decision.reason ?? decision.kind), { code: decision.info?.code ?? 'NATIVE_POLICY_DENIED' });
      }
      // Native pipeline checks caller cancellation after checkGuards and before dispatch.
      exec.signal.throwIfAborted();
      if (pauseHere) pausedBodyCalls++;
      let value;
      try { value = await execute(); }
      catch (error) {
        childEmit('session/event', child.session, { type: 'tool/result', data: { message: { toolCallId: callId, isError: true } } });
        throw error;
      }
      childEmit('session/event', child.session, { type: 'tool/result', data: { message: { toolCallId: callId,
        ...(options.omitSuccessFlag ? {} : { isError: false }) } } });
      return value;
    }
    emit('subagent/start', { id: child.id, runId: `run-${role}`, provider: 'spawn', parentSessionId: root.id, local: true });
    if (options.lateStart) latePublished.resolve();
    const work = async () => {
      if (options.probeUnrelated && role === 'reviewer') {
        const guard = [...localHooks.get('tools/pre-execute')][0];
        for (const agent of [root, { id: 'unrelated-agent' }]) {
          const decision = await guard({ agent, name: 'bash', callId: 'unrelated', arguments: {}, signal: new AbortController().signal }, async () => { unrelatedPasses++; return { kind: 'allow' }; });
          assert.equal(decision.kind, 'allow');
        }
      }
      const hook = [...hooks.get('llm/stream')][0];
      const tools = TEAM_ROLE_TOOLS.map(name => ({ name, description: 'synthetic official schema', parameters: { type: 'object', properties: {} } }));
      const stream = async function* () { providerCalls++; yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }; yield { type: 'finish', reason: { kind: 'stop' } }; };
      for await (const _ of hook({ ...binding.route, sessionId: child.id, tools, messages: [] }, stream)) {}
      if (options.hang) return;
      const attack = async stage => {
        if (options.attack?.role !== role || (options.attack.stage ?? 'initial') !== stage) return;
        await tool(options.attack.name, options.attack.args, () => { attackBodies++; return { unexpected: 'body dispatched' }; });
      };
      await attack('initial');
      if (role === 'reviewer') {
        await tool('wait_agent', { timeout_ms: 30000 }, async () => {
          order.push('reviewer-wait');
          await Promise.race([messageReady, new Promise((_, reject) => {
            const abort = () => reject(new Error('synthetic native wait canceled'));
            if (toolController.signal.aborted) abort(); else toolController.signal.addEventListener('abort', abort, { once: true });
          })]);
          return { timedOut: false };
        });
        if (interrupted) return;
        const implementation = await tool('team_task_get', { task_id: '1' }, () => team.getTask(child, '1'));
        assert.equal(implementation.status, 'completed');
        let task = await tool('team_task_get', { task_id: '2' }, () => team.getTask(child, '2'));
        task = await tool('team_task_update', { task_id: '2', expected_revision: task.revision, action: 'claim' }, () => update(child, { task_id: '2', expected_revision: task.revision, action: 'claim' }));
        await tool('team_task_update', { task_id: '2', expected_revision: task.revision, action: 'complete' }, () => update(child, { task_id: '2', expected_revision: task.revision, action: 'complete' }));
      } else {
        let task = await tool('team_task_get', { task_id: '1' }, () => team.getTask(child, '1'));
        await attack('after-own-read');
        task = await tool('team_task_update', { task_id: '1', expected_revision: task.revision, action: 'claim' }, () => update(child, { task_id: '1', expected_revision: task.revision, action: 'claim' }));
        const description = JSON.stringify({ runTag: config.runTag, role, value: 5 });
        task = await tool('team_task_update', { task_id: '1', expected_revision: task.revision, action: 'edit', description }, () => update(child, { task_id: '1', expected_revision: task.revision, action: 'edit', description }));
        await tool('team_task_update', { task_id: '1', expected_revision: task.revision, action: 'complete' }, () => update(child, { task_id: '1', expected_revision: task.revision, action: 'complete' }));
        await attack('after-complete');
        const message = JSON.stringify({ runTag: config.runTag, implementationTaskId: '1', value: 5 });
        await tool('send_message', { agent: config.roles.reviewer.memberName, message }, () => {
          order.push('handoff'); const reviewer = childRecords.get('child-reviewer');
          const delivered = { id: 'peer-message', source: { kind: 'agent-message', senderSessionId: child.id }, content: [{ type: 'text', text: 'Agent implementer sent a message: ' }, { type: 'text', text: message }] };
          reviewer.deliver(delivered); releaseMessage(); return { messageId: delivered.id };
        });
      }
      finish();
    };
    record.deliver = message => childEmit('agent/inbox/inserted', { agent: child, message });
    if (!options.lateStart) queueMicrotask(() => work().catch(error => { record.error = error; finish('error'); }));
    return { results: [{ callId: input.calls[0].id, result: { isError: false, value: { kind: 'activation', name: binding.memberName } } }], additionalContexts: [], concluded: false };
  }
  root.ctx.tools = { async resolve() { options.onToolResolution?.(); return { view: () => new Map(mounted ? [['dsh_live_team_spawn', {}]] : []), dispose() {} }; }, execute: spawn };
  root.ctx.plugin = (_module, spec) => {
    assert.equal(spec.maxDepth, 1); assert.deepEqual(spec.allowedAgentPresets, Object.values(config.roles).map(r => r.presetId));
    mounted = true; const p = Promise.resolve(); p.dispose = async () => {
      disposals++; mounted = false; order.push('tool-disposed');
      if (options.lateBoardConflict) tasks.get('1').revision++;
    }; return p;
  };
  const ctx = { agents: { get: id => agents.get(id) }, agentTeams: team,
    workingDirectory: { get: session => {
      if (session !== root.session && options.childDirectoryError) throw new Error('native directory unavailable');
      return session !== root.session && options.childDirectory ? '/outside-child-workspace' : liveWorkspace;
    } },
    // Durable projection reads remain available while Team mode is disabled; they are not board service calls.
    sessionProjections: { stateOf(_session, key) { return key === 'agentTeam'
      ? { ...(teamModeSaved ? { enabled: teamEnabled } : {}), id: root.id, tasks: [...tasks.values()].map(task => structuredClone(task)), nextTaskNumber: createAttempts + 1 }
      : options.unauthorized ? [] : Object.values(config.roles).map(r => r.route); } },
    llm: { async resolveCallConfig(route) { return route; } },
    agentPresets: { async register(def) { presets.set(def.id, def); return async () => { unregisters++; presets.delete(def.id); }; }, composedPreset: scope => scope.preset },
    subagents: { interrupt(id, auth) { assert.equal(auth.agent, root); interrupts++; if (options.throwInterrupt) throw new Error('synthetic interrupt failure'); childRecords.get(id).interrupt(); } },
    on: (name, fn) => on(hooks, name, fn), commands: { register(def) { commands.set(def.name, def); return () => commands.delete(def.name); } },
    effect(generator) { for (const dispose of generator()) effects.push(dispose); },
  };
  await applyTeam(bindRc5Fixture(ctx), config, native, { name: CONTROL_ENTRY, config: { interrupt: false } });
  return { config, root, hooks, tasks, order,
    setWorkingDirectory: value => { liveWorkspace = value; },
    invoke: () => commands.get('dsh-team-live').handler({ agent: root, rawInput: 'run-pair', attachments: [], signal: commandController.signal }),
    dispose: async () => { for (const fn of effects.slice().reverse()) await fn(); },
    release: () => { for (const record of childRecords.values()) record.finish('aborted'); releaseMessage(); },
    cancel: () => commandController.abort(), policyEntered: policyEntered.promise, releasePolicy: () => policyReady.resolve(),
    childrenReady: childrenReady.promise, creationEntered: creationEntered.promise, releaseCreation: () => creationReady.resolve(), latePublished: latePublished.promise,
    activationRejected: activationRejected.promise, childIds: () => [...childRecords.keys()],
    enableEntered: enableEntered.promise, releaseEnable: () => enableReady.resolve(),
    addForeignTask: () => tasks.set('foreign-policy', { id: 'foreign-policy', revision: 1, status: 'pending', subject: 'foreign', description: 'foreign', blockedBy: [], writeScopes: [] }),
    tryStream: async role => {
      const hook = [...hooks.get('llm/stream')][0], binding = config.roles[role];
      const messages = [{ id: 'fresh-result-after-close', role: 'tool', source: { kind: 'tool', callId: 'fresh-call' }, toolCallId: 'fresh-call', content: [] }];
      for await (const _ of hook({ ...binding.route, sessionId: `child-${role}`, tools: TEAM_ROLE_TOOLS.map(name => ({ name })), messages }, async function* () {
        providerCalls++; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } };
      })) {}
    },
    stats: () => ({ mounted, disposals, interrupts, unregisters, mutations, createAttempts, teamEnabled, attackBodies, unrelatedPasses, providerCalls, policyCalls, pausedBodyCalls,
      childErrors: [...childRecords.values()].flatMap(c => c.error ? [c.error.message] : []) }),
  };
}

test('Team pair rejects a changed live parent workspace without changing the board', async t => {
  const h = await fixture(t); h.setWorkingDirectory('/outside-owned-workspace');
  const result = await h.invoke();
  assert.match(result.text, /WRONG_WORKSPACE/);
  assert.equal(h.stats().mutations, 0); assert.deepEqual(h.childIds(), []);
  await h.dispose();
});

test('Team pair rechecks live workspace after tool resolution before its first write', async t => {
  const h = await fixture(t, { onToolResolution: () => h.setWorkingDirectory('/outside-owned-workspace') });
  const result = await h.invoke();
  assert.match(result.text, /WRONG_WORKSPACE/);
  assert.equal(h.stats().mutations, 0); assert.deepEqual(h.childIds(), []);
  assert.equal(h.stats().disposals, 1); await h.dispose();
});

for (const scenario of ['inner-preflight', 'child-directory', 'directory-error']) {
  test(`Team pair blocks ${scenario} at native child publication before model execution`, async t => {
    const h = await fixture(t, { childDirectory: scenario === 'child-directory', childDirectoryError: scenario === 'directory-error',
      nativePreflight: scenario === 'inner-preflight' ? async () => {
        await Promise.resolve(); h.setWorkingDirectory('/outside-owned-workspace');
      } : undefined });
    const result = await h.invoke();
    assert.match(result.text, /CHILD_CONFIGURATION_CHANGED/);
    assert.equal(h.stats().providerCalls, 0); assert.ok(h.stats().interrupts >= 1);
    assert.deepEqual(h.childIds(), ['child-reviewer']); assert.equal(h.stats().mounted, false);
    await h.dispose();
  });
}

test('TEAM_DISABLED cold root enables the native task board before using it', async t => {
  const h = await fixture(t); assert.equal(h.stats().teamEnabled, false);
  const result = await h.invoke();
  assert.equal(result.kind, 'success', result.text);
  const firstRead = h.order.findIndex(event => event === 'board:listTasks' || event === 'board:getTask');
  assert.ok(h.order.indexOf('team:true') >= 0 && h.order.indexOf('team:true') < firstRead);
  assert.equal(h.stats().teamEnabled, false); assert.equal(h.tasks.size, 2); await h.dispose();
});

test('TEAM_DISABLED existing durable tasks survive enabling and restoring a disabled root', async t => {
  const initialTasks = [
    { id: 'retained-completed', revision: 5, status: 'completed', ownerId: 'retained-owner', subject: 'Prior result', description: 'Keep this accepted result', blockedBy: [], writeScopes: ['retained-scope'] },
    { id: 'retained-pending', revision: 2, status: 'pending', subject: 'Prior follow-up', description: 'Keep this pending work', blockedBy: ['retained-completed'], writeScopes: [] },
    { id: 'retained-deleted', revision: 4, status: 'deleted', subject: 'Prior tombstone', description: 'Keep this deleted task record', blockedBy: [], writeScopes: [] },
  ];
  const h = await fixture(t, { initialTasks }); assert.equal(h.stats().teamEnabled, false);
  const result = await h.invoke();
  assert.equal(result.kind, 'success', result.text);
  for (const original of initialTasks) assert.deepEqual(h.tasks.get(original.id), original);
  assert.equal(h.tasks.size, 5); assert.equal(h.stats().teamEnabled, false);
  assert.deepEqual(h.order.filter(event => event.startsWith('team:')), ['team:true', 'team:false']); await h.dispose();
});

test('TEAM_DISABLED foreign board drift during enable flush is rejected before task creation', async t => {
  const h = await fixture(t, { pauseEnable: true }); const command = h.invoke();
  await h.enableEntered; h.addForeignTask(); h.releaseEnable();
  const result = await command, error = JSON.parse(result.text);
  assert.equal(error.code, 'TEAM_BOARD_CONCURRENT_CHANGE'); assert.equal(error.reconciliationRequired, true);
  assert.equal(h.stats().createAttempts, 0); assert.deepEqual(h.childIds(), []); assert.equal(h.stats().providerCalls, 0);
  assert.equal(h.tasks.get('foreign-policy').description, 'foreign'); assert.equal(h.stats().teamEnabled, true);
  assert.deepEqual(h.order.filter(event => event.startsWith('team:')), ['team:true']); await h.dispose();
});

test('native pair uses child-owned task CAS and peer delivery, then restores only its Team selection', async t => {
  const h = await fixture(t); const result = await h.invoke();
  assert.equal(result.kind, 'success', result.text + JSON.stringify(h.stats()));
  const value = JSON.parse(result.text);
  assert.deepEqual(h.order.filter(x => x.startsWith('spawn:')), ['spawn:reviewer', 'spawn:implementer']);
  assert.ok(h.order.indexOf('reviewer-wait') < h.order.indexOf('handoff'));
  assert.equal(value.roles.implementer.task.ownerId, 'child-implementer'); assert.equal(value.roles.reviewer.task.ownerId, 'child-reviewer');
  assert.deepEqual(value.roles.reviewer.task.blockedBy, ['1']); assert.equal(value.peerMessage.id, 'peer-message');
  assert.deepEqual(value.cancelledParentNoticeIds.slice().sort(), ['notice-implementer', 'notice-reviewer']);
  assert.equal(value.teamModeRestored, true); assert.equal(h.stats().teamEnabled, false); assert.equal(h.stats().disposals, 1);
  assert.equal(h.root.inbox.nextTurn.length, 0); assert.equal(h.tasks.size, 2);
  assert.match((await h.invoke()).text, /RUN_ALREADY_ATTEMPTED/); assert.equal(h.stats().createAttempts, 2);
  await h.dispose(); assert.equal(h.stats().unregisters, 2);
});

test('an already-enabled Team stays enabled after a settled pair', async t => {
  const h = await fixture(t, { teamAlreadyEnabled: true }); assert.equal((await h.invoke()).kind, 'success');
  assert.equal(h.stats().teamEnabled, true); await h.dispose();
});

test('native tool results with the optional isError flag omitted are successful', async t => {
  const h = await fixture(t, { omitSuccessFlag: true });
  assert.equal((await h.invoke()).kind, 'success'); await h.dispose();
});

test('policy refusal creates no tasks or children and does not change Team mode', async t => {
  const h = await fixture(t, { unauthorized: true }); const result = await h.invoke();
  assert.equal(result.kind, 'error'); assert.equal(h.stats().mutations, 0); assert.equal(h.stats().createAttempts, 0);
  assert.equal(h.order.some(x => x.startsWith('spawn:')), false); assert.equal(h.stats().disposals, 1); await h.dispose();
});

test('partial child creation failure drains the reviewer before scoped disposal and Team restoration', async t => {
  const h = await fixture(t, { failImplementer: true }); const result = await h.invoke();
  assert.match(result.text, /NATIVE_DELEGATION_FAILED/); assert.ok(h.stats().interrupts >= 1);
  assert.ok(h.order.indexOf('end:reviewer') < h.order.indexOf('tool-disposed'));
  assert.ok(h.order.indexOf('tool-disposed') < h.order.indexOf('team:false'));
  assert.equal(h.stats().teamEnabled, false); assert.equal(h.tasks.size, 2);
  assert.match((await h.invoke()).text, /RUN_ALREADY_ATTEMPTED/); await h.dispose();
});

test('unrelated root input is preserved and fails the pair rather than being canceled as a child notice', async t => {
  const h = await fixture(t, { foreignInbox: true }); const result = await h.invoke();
  assert.match(result.text, /ROOT_INBOX_CHANGED/);
  assert.ok(h.root.inbox.nextTurn.some(m => m.id === 'foreign-input'));
  assert.equal(h.root.inbox.nextTurn.length, 3); assert.equal(h.stats().teamEnabled, true);
  const error = JSON.parse(result.text); assert.equal(error.reconciliationRequired, true); assert.equal(error.remainingTeamMode, true);
  assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']); await h.dispose();
});

test('foreign task-board mutation prevents further creation without overwriting it', async t => {
  const h = await fixture(t, { foreignBoard: true }); const result = await h.invoke();
  assert.match(result.text, /TEAM_BOARD_CONCURRENT_CHANGE/); assert.equal(h.stats().createAttempts, 1);
  // Another actor's task invalidates our restoration authority; leave its active Team mode alone.
  assert.equal(h.tasks.get('foreign').description, 'other work'); assert.equal(h.stats().teamEnabled, true);
  assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']);
  const error = JSON.parse(result.text); assert.equal(error.reconciliationRequired, true);
  assert.equal(error.teamModeRestored, false); assert.equal(error.remainingTeamMode, true);
  assert.deepEqual(error.observedTaskIds, ['1', 'foreign']); await h.dispose();
});

test('a concurrent Team-mode selection stops writes and reports the current mode for reconciliation', async t => {
  const h = await fixture(t, { foreignMode: true }); const result = await h.invoke();
  const error = JSON.parse(result.text); assert.equal(error.code, 'TEAM_MODE_CONCURRENT_CHANGE');
  assert.equal(error.reconciliationRequired, true); assert.equal(error.remainingTeamMode, false);
  assert.equal(error.teamModeRestored, false); assert.equal(h.stats().createAttempts, 1);
  assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']); await h.dispose();
});

test('unexpected ownership, revision or scope of an owned task leaves mode and tasks for reconciliation', async t => {
  for (const ownTaskConflict of ['owner', 'revision', 'scope']) {
    const h = await fixture(t, { ownTaskConflict }); const result = await h.invoke();
    const error = JSON.parse(result.text); assert.equal(result.kind, 'error', ownTaskConflict);
    assert.equal(error.reconciliationRequired, true, ownTaskConflict); assert.equal(error.remainingTeamMode, true);
    assert.equal(error.teamModeRestored, false); assert.deepEqual(error.observedTaskIds, ['1', '2']);
    assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']);
    assert.equal(h.stats().disposals, 1); assert.equal(h.root.inbox.nextTurn.length, 0); await h.dispose();
  }
});

test('a board change during scoped-tool disposal is detected before any restoration write', async t => {
  const h = await fixture(t, { lateBoardConflict: true }); const result = await h.invoke();
  const error = JSON.parse(result.text); assert.equal(error.code, 'TEAM_TASK_STATE_CONCURRENT_CHANGE');
  assert.equal(error.reconciliationRequired, true); assert.equal(error.remainingTeamMode, true);
  assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']); await h.dispose();
});

test('child scope rejects foreign task reads, writes and delete before the native body', async t => {
  const attacks = [
    { role: 'implementer', name: 'team_task_get', args: { task_id: 'foreign' } },
    { role: 'implementer', name: 'team_task_update', args: { task_id: 'foreign', expected_revision: 1, action: 'claim' } },
    { role: 'implementer', name: 'team_task_update', args: { task_id: 'foreign', expected_revision: 1, action: 'delete' } },
    { role: 'implementer', name: 'team_task_update', args: { task_id: '1', expected_revision: 1, action: 'delete' } },
    { role: 'implementer', name: 'team_task_update', stage: 'after-own-read', args: { task_id: '1', expected_revision: 2, action: 'claim' } },
    { role: 'implementer', name: 'team_task_update', stage: 'after-own-read', args: { task_id: '1', expected_revision: 1, action: 'claim', write_scopes: ['foreign-scope'] } },
    { role: 'reviewer', name: 'team_task_list', args: {} },
  ];
  for (const attack of attacks) {
    const h = await fixture(t, { attack }); const result = await h.invoke(); const error = JSON.parse(result.text);
    assert.equal(h.stats().attackBodies, 0, JSON.stringify(attack));
    assert.equal(result.kind, 'error'); assert.equal(error.operationFailure, 'TEAM_TOOL_SCOPE_DENIED', result.text);
    assert.equal(error.reconciliationRequired, true); assert.equal(error.remainingTeamMode, true);
    assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']);
    assert.equal(h.tasks.get('foreign').revision, 1);
    assert.equal(h.tasks.get('foreign').description, 'private other task content');
    assert.ok(Object.values(error.children).some(c => c.scopeDenials.length === 1));
    assert.ok(h.stats().providerCalls <= 2); assert.equal(h.stats().mounted, false); await h.dispose();
  }
});

test('child scope rejects messages to lead, wrong peer and reviewer sends before the native body', async t => {
  const message = JSON.stringify({ runTag: 'live-team-test', implementationTaskId: '1', value: 5 });
  for (const attack of [
    { role: 'implementer', name: 'send_message', stage: 'after-complete', args: { agent: 'lead', message } },
    { role: 'implementer', name: 'send_message', stage: 'after-complete', args: { agent: 'wrong-peer', message } },
    { role: 'implementer', name: 'send_message', stage: 'after-complete', args: { agent: 'live-test-reviewer', message: JSON.stringify({ runTag: 'wrong-run', implementationTaskId: '1', value: 5 }) } },
    { role: 'reviewer', name: 'send_message', args: { agent: 'lead', message } },
  ]) {
    const h = await fixture(t, { attack }); const result = await h.invoke(); const error = JSON.parse(result.text);
    assert.equal(h.stats().attackBodies, 0); assert.equal(error.operationFailure, 'TEAM_TOOL_SCOPE_DENIED', result.text);
    assert.equal(error.reconciliationRequired, true); assert.equal(error.remainingTeamMode, true);
    assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']);
    assert.equal(h.root.inbox.nextTurn.length, 0); assert.ok(h.stats().providerCalls <= 2); await h.dispose();
  }
});

test('child tool guards pass root and unrelated callers through the remaining native policy', async t => {
  const h = await fixture(t, { probeUnrelated: true }); const result = await h.invoke();
  assert.equal(result.kind, 'success', result.text); assert.equal(h.stats().unrelatedPasses, 2); await h.dispose();
});

test('uncertain native persistence is reported without retry or another Team-mode write', async t => {
  const h = await fixture(t, { persistenceFailure: true }); const result = await h.invoke();
  const error = JSON.parse(result.text); assert.equal(error.persistenceUnconfirmed, true); assert.equal(error.teamModeRestored, false);
  assert.equal(h.stats().teamEnabled, true); assert.equal(h.stats().createAttempts, 2); assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']);
  assert.match((await h.invoke()).text, /RUN_ALREADY_ATTEMPTED/); await h.dispose();
});

test('timeout and interrupt errors retain both guards until both exact child lifecycles end', async t => {
  const h = await fixture(t, { hang: true, throwInterrupt: true }); const result = await h.invoke();
  assert.match(result.text, /TIMEOUT_DRAINING_GUARD_RETAINED/); assert.equal(JSON.parse(result.text).interruptFailed, true);
  let unloaded = false; const disposal = h.dispose().then(() => { unloaded = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unloaded, false); assert.equal(h.stats().mounted, true); assert.equal(h.stats().teamEnabled, true);
  await assert.rejects(async () => {
    const hook = [...h.hooks.get('llm/stream')][0];
    for await (const _ of hook({ sessionId: h.root.id }, () => assert.fail('root quarantine was removed'))) {}
  }, /ROOT_QUARANTINED/);
  h.release(); await disposal;
  assert.equal(h.stats().mounted, false); assert.equal(h.stats().teamEnabled, false); assert.equal(h.hooks.get('llm/stream').size, 0);
});

test('unload during asynchronous marker checks admits no runtime work', async t => {
  const h = await fixture(t); const command = h.invoke(); await h.dispose();
  assert.match((await command).text, /UNLOADING/); assert.equal(h.stats().mutations, 0); assert.equal(h.stats().mounted, false);
});

for (const phase of ['next', 'ask']) {
  test(`F1 ${phase} rechecks board before body dispatch`, async t => {
    const h = await fixture(t, { policy: { role: 'implementer', name: 'team_task_update', action: 'claim', phase } });
    const command = h.invoke(); await h.policyEntered;
    assert.equal(h.stats().pausedBodyCalls, 0); h.addForeignTask(); h.releasePolicy();
    const result = await command, error = JSON.parse(result.text);
    assert.equal(h.stats().pausedBodyCalls, 0, phase); assert.equal(h.stats().policyCalls, 1);
    assert.equal(error.reconciliationRequired, true); assert.equal(error.remainingTeamMode, true);
    assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']); await h.dispose();
  });
}

test('F1 cancellation and closing cannot cross a suspended native allow or ask even when interrupt throws', async t => {
  for (const phase of ['next', 'ask']) for (const stop of ['cancel', 'closing']) {
    const h = await fixture(t, { throwInterrupt: true, policy: { role: 'implementer', name: 'team_task_update', action: 'claim', phase } });
    const command = h.invoke(); await h.policyEntered;
    let disposal;
    if (stop === 'cancel') h.cancel(); else disposal = h.dispose();
    const result = await command; assert.match(result.text, /DRAINING_GUARD_RETAINED/);
    h.releasePolicy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.stats().pausedBodyCalls, 0, `${phase}/${stop}`); assert.equal(h.stats().policyCalls, 1);
    h.release(); await (disposal ?? h.dispose());
  }
});

test('F1 invokes native policy once and preserves allow and deny decisions including ask', async t => {
  for (const phase of ['next', 'ask']) for (const decision of ['allow', 'deny']) {
    const h = await fixture(t, { policy: { role: 'implementer', name: 'team_task_update', action: 'claim', phase, decision } });
    const command = h.invoke(); await h.policyEntered;
    assert.equal(h.stats().pausedBodyCalls, 0); h.releasePolicy(); const result = await command;
    assert.equal(h.stats().policyCalls, 1); assert.equal(h.stats().pausedBodyCalls, decision === 'allow' ? 1 : 0);
    assert.equal(result.kind, decision === 'allow' ? 'success' : 'error'); await h.dispose();
  }
});

test('F2 cleanup detects owned task drift independently of bad JSON, wrong persona or abnormal end', async t => {
  for (const badOutput of ['json', 'nonce', 'end']) for (const ownTaskConflict of ['owner', 'revision', 'scope']) {
    const h = await fixture(t, { badOutput, ownTaskConflict }); const result = await h.invoke();
    const error = JSON.parse(result.text);
    assert.equal(error.reconciliationRequired, true, `${badOutput}/${ownTaskConflict}`);
    assert.equal(error.teamModeRestored, false); assert.equal(error.remainingTeamMode, true);
    assert.deepEqual(h.order.filter(x => x.startsWith('team:')), ['team:true']);
    if (ownTaskConflict === 'owner') assert.equal(h.tasks.get('1').ownerId, 'foreign-child');
    if (ownTaskConflict === 'revision') assert.equal(h.tasks.get('1').revision, 5);
    if (ownTaskConflict === 'scope') assert.deepEqual(h.tasks.get('1').writeScopes, ['foreign-scope']);
    assert.equal(h.root.inbox.nextTurn.length, 0); await h.dispose();
  }
});

test('F2 output validation errors without native task drift still restore the owned Team selection', async t => {
  for (const badOutput of ['json', 'nonce', 'end']) {
    const h = await fixture(t, { badOutput }); const result = await h.invoke(), error = JSON.parse(result.text);
    assert.equal(result.kind, 'error'); assert.equal(error.reconciliationRequired, false);
    assert.equal(error.teamModeRestored, true); assert.equal(h.stats().teamEnabled, false);
    assert.equal(h.tasks.get('1').revision, 4); assert.equal(h.tasks.get('2').revision, 3); await h.dispose();
  }
});

test('F3 timeout and cancel synchronously close remaining model budget while exact children drain', async t => {
  for (const stop of ['timeout', 'cancel']) {
    const h = await fixture(t, { hang: stop === 'timeout' ? true : 'manual', throwInterrupt: true });
    const command = h.invoke(); await h.childrenReady; if (stop === 'cancel') h.cancel();
    const result = await command, error = JSON.parse(result.text);
    assert.match(result.text, /DRAINING_GUARD_RETAINED/);
    const before = h.stats().providerCalls;
    const denied = await h.tryStream('implementer').then(() => null, error => error);
    assert.equal(h.stats().providerCalls, before, 'a stopped operation must not enter another provider stream');
    assert.match(denied?.message ?? '', /TEAM_GATE_CLOSED/); assert.equal(error.modelEvidence.closed, true);
    assert.equal(h.stats().mounted, true); h.release(); await h.dispose();
  }
});

test('F3 unload and terminal partial activation failure close admission before interrupt errors', async t => {
  for (const stop of ['unload', 'activation']) {
    const h = await fixture(t, { hang: 'manual', throwInterrupt: true, failImplementer: stop === 'activation' });
    const command = h.invoke(); let disposal;
    if (stop === 'unload') { await h.childrenReady; disposal = h.dispose(); await command; }
    else { await h.activationRejected; await new Promise(resolve => setImmediate(resolve)); }
    const before = h.stats().providerCalls;
    await assert.rejects(h.tryStream('reviewer'), /TEAM_GATE_CLOSED/); assert.equal(h.stats().providerCalls, before);
    assert.equal(h.stats().mounted, true); h.release(); await command; await (disposal ?? h.dispose());
  }
});

test('F3 canceled creation retains the late published child identity and guard until its actual end', async t => {
  const h = await fixture(t, { lateStart: true, throwInterrupt: true }); const command = h.invoke();
  await h.creationEntered; h.cancel(); const result = await command;
  assert.equal(JSON.parse(result.text).modelEvidence.closed, true);
  h.releaseCreation(); await h.latePublished; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.childIds(), ['child-reviewer']); assert.equal(h.order.includes('spawn:implementer'), false);
  let unloaded = false; const disposal = h.dispose().then(() => { unloaded = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(unloaded, false);
  assert.equal(h.hooks.get('llm/stream').size, 1); assert.equal(h.stats().mounted, true);
  await assert.rejects(h.tryStream('reviewer'), /UNEXPECTED_CHILD|TEAM_GATE_CLOSED/); assert.equal(h.stats().providerCalls, 0);
  h.release(); await disposal; assert.equal(h.stats().mounted, false); assert.equal(h.stats().teamEnabled, false);
});

test('native delegation diagnostics identify all seven batch mismatches without accepting a missing success flag', async t => {
  const cases = [
    ['RESULT_COUNT', batch => batch.results.push(structuredClone(batch.results[0]))],
    ['CALL_ID', batch => { batch.results[0].callId = 'wrong-call'; }],
    // Intentionally malformed execution-local success: unlike durable event messages this flag is required.
    ['RESULT_ERROR_FLAG', batch => { delete batch.results[0].result.isError; }],
    ['ACTIVATION_KIND', batch => { batch.results[0].result.value.kind = 'wrong-kind'; }],
    ['ACTIVATION_NAME', batch => { batch.results[0].result.value.name = 'wrong-member'; }],
    ['ADDITIONAL_CONTEXTS', batch => { batch.additionalContexts.push({ role: 'user', content: [] }); }],
    ['CONCLUDED_FLAG', batch => { batch.concluded = true; }],
  ];
  for (const [code, mutate] of cases) {
    const h = await fixture(t, { nativeBatch({ callId, memberName }) {
      const batch = { results: [{ callId, result: { isError: false, value: { kind: 'activation', name: memberName }, content: [] } }], additionalContexts: [], concluded: false };
      mutate(batch); return batch;
    } });
    const result = await h.invoke(), error = JSON.parse(result.text);
    assert.equal(error.code, 'NATIVE_DELEGATION_FAILED');
    assert.deepEqual(error.delegationFailure.mismatches, [code], result.text);
    assert.equal(error.delegationFailure.role, 'reviewer'); assert.equal(h.stats().providerCalls, 0); await h.dispose();
  }
});

test('native delegation diagnostics enumerate concurrent malformed batch fields rather than short-circuiting', async t => {
  const h = await fixture(t, { nativeBatch: () => ({ results: [], additionalContexts: [{}], concluded: true }) });
  const result = await h.invoke(), error = JSON.parse(result.text);
  assert.equal(error.code, 'NATIVE_DELEGATION_FAILED');
  assert.deepEqual(error.delegationFailure.mismatches, ['RESULT_COUNT', 'CALL_ID', 'RESULT_ERROR_FLAG', 'ACTIVATION_KIND', 'ACTIVATION_NAME', 'ADDITIONAL_CONTEXTS', 'CONCLUDED_FLAG']);
  assert.deepEqual(error.delegationFailure.batchResult, { resultCount: 0, callIdMatches: false, isError: null, activationKindMatches: false,
    activationNameMatches: false, additionalContextCount: 1, concluded: true });
  await h.dispose();
});

test('native error diagnostics preserve safe structure and omit secrets, headers, queries and full content', async t => {
  const secret = 'never-print-synthetic-credential-893';
  for (const knownRestriction of [false, true, 'unsafe-identifiers']) {
    const h = await fixture(t, { nativeBatch({ callId }) {
      return { results: [{ callId, result: { isError: true, error: {
        info: { name: knownRestriction === 'unsafe-identifiers' ? `SecretError_${secret}` : 'Error',
          code: knownRestriction === 'unsafe-identifiers' ? `API_KEY_${secret}` : 'TOOL_ERROR', reason: `Authorization: Bearer ${secret}` },
        message: knownRestriction === true
          ? `tools.restrict() names unknown global tools "send_message", "wait_agent"; known global tools: ${secret}`
          : `startup failed Authorization: Bearer ${secret}; https://provider.test/start?token=${secret}`,
        stack: `private stack ${secret}`,
      }, content: [{ type: 'text', text: `private prompt ${secret}` }] } }], additionalContexts: [], concluded: false };
    } });
    const result = await h.invoke(), error = JSON.parse(result.text), diagnostic = error.delegationFailure.nativeError;
    assert.equal(error.code, 'NATIVE_DELEGATION_FAILED'); assert.equal(diagnostic.messageRedacted, true);
    assert.equal(diagnostic.message, knownRestriction === true
      ? 'tools.restrict() names unknown global tools: send_message, wait_agent' : 'Native error message omitted');
    assert.equal(diagnostic.name, knownRestriction === 'unsafe-identifiers' ? undefined : 'Error');
    assert.equal(diagnostic.code, knownRestriction === 'unsafe-identifiers' ? undefined : 'TOOL_ERROR');
    for (const fragment of [secret, 'Authorization', 'provider.test', '?token=', 'private prompt', 'private stack']) assert.equal(result.text.includes(fragment), false);
    assert.equal(h.stats().providerCalls, 0); await h.dispose();
  }
});
