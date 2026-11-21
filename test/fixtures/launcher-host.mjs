import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyLauncherRole } from '../../launcher-role.js';
import { nativeEffectOwner } from './native-effect-owner.mjs';
import { CONTROL } from './control-entry.mjs';

export { CONTROL };
const ROLES = ['implementer', 'reviewer'];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const clone = value => structuredClone(value);
const nativeError = code => Object.assign(new Error(code), { code });
const listen = (hooks, name, fn) => {
  if (!hooks.has(name)) hooks.set(name, new Set());
  hooks.get(name).add(fn); return () => hooks.get(name).delete(fn);
};
const emit = (hooks, name, ...values) => { for (const fn of hooks.get(name) ?? []) fn(...values); };

/** Bounded synthetic native contracts, never an Electron/provider/session-persistence implementation. */
export async function launcherHost(t, applyLauncher, options = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-launcher-host-')));
  let effectiveWorkspace = workspace;
  const childWorkspaces = new Map();
  const template = {
    template_schema: 'dsh-team-template/1', template_meta: { live_verified: false }, version: 1,
    name: 'owned-launcher-test', members: ROLES.map((role, index) => ({
      name: role, description: `Owned ${role} startup`, prompt: `Startup ${role}: use your supplied native task context.`,
      persona_prompt: `PRIVATE_PERSONA_${role}_EXACT_SENTINEL: you are the ${role}.`,
      agent_preset: `dsh-team-launcher-${role}`, provider: 'deepseek-account',
      model: index === 0 ? 'deepseek-flash' : 'deepseek-v4-pro', reasoning_effort: 'low',
      native_tool_allowlist: ['team_task_get', 'team_task_update', index === 0 ? 'send_message' : 'wait_agent'],
    })), seed_tasks: [
      { key: 'implement', subject: 'Implement 2+3', description: 'Compute 5 and deliver to the reviewer.', owner: 'implementer' },
      { key: 'review', subject: 'Review implementation', description: 'Wait for the peer, independently check 5, then complete.', owner: 'reviewer', blocked_by: ['implement'] },
    ],
  };
  for (const member of template.members) Object.assign(member, options.memberConfig?.[member.name]);
  const bytes = JSON.stringify(template);
  const config = { mode: 'launcher', ownedSessionId: options.sessionId ?? 'session-11111111-1111-4111-8111-111111111111', workspace,
    runTag: 'launcher-owned-test', timeoutMs: options.hang ? 25 : 3000,
    templateSha256: createHash('sha256').update(bytes).digest('hex'),
    startup: { maxTokens: 1024, maxStreams: { implementer: 8, reviewer: 7 } } };
  await writeFile(join(workspace, '.dsh-team-template.json'), bytes, { mode: 0o600 });
  await writeFile(join(workspace, '.dsh-team-launcher.json'), JSON.stringify({ purpose: 'dsh-native-team-launcher',
    ownedSessionId: config.ownedSessionId, runTag: config.runTag, templateSha256: config.templateSha256 }), { mode: 0o600 });

  const commands = new Map(), hooks = new Map(), agents = new Map(), presets = new Map(), owner = nativeEffectOwner();
  const tasks = new Map(), catalog = new Map(), children = new Map(), order = [], writes = [], preflights = [];
  const bodyCalls = [], providerCalls = [], createdPresets = [], removedPresets = [], noticesRemoved = [], newWork = [];
  const sharedTools = new Map(['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']
    .map(name => [name, { name, description: name }]));
  for (const tool of options.workTools ?? []) sharedTools.set(tool.name, tool);
  const rootPresetTools = new Map((options.presetTools ?? []).map(tool => [tool.name, tool]));
  let enabled = options.priorEnabled === true, mount, nextTask = 1, spawnAttempts = 0, wakeCalls = 0, disposed = false, approvalUsed = false, modeDrifted = false, released = false;
  const peer = deferred(), latePublication = deferred(), peerWaitTimeout = deferred();
  const createDeleteForeign = () => {
    const task = { id: `task-${nextTask++}`, revision: 2, subject: 'Concurrent created then deleted', description: 'External tombstone',
      status: 'deleted', blockedBy: [], writeScopes: [] };
    tasks.set(task.id, task); order.push(`foreign-create-delete:${task.id}`); return task.id;
  };
  if (options.initialTombstone) createDeleteForeign();
  const root = { id: config.ownedSessionId, session: { id: config.ownedSessionId,
    header: { cwd: workspace, agentPreset: 'standard' } }, status: 'idle',
    model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }) },
    ctx: {}, inbox: { nextStep: [], nextTurn: [], remove(id) {
      for (const queue of [this.nextStep, this.nextTurn]) {
        const index = queue.findIndex(message => message.id === id);
        if (index !== -1) { queue.splice(index, 1); noticesRemoved.push(id); return true; }
      }
      return false;
    } },
    async runMaintenance(fn) { assert.equal(this.status, 'idle'); order.push('maintenance-enter');
      try { return await fn(new AbortController().signal); } finally { order.push('maintenance-exit'); } },
    async whenIdle() { assert.equal(this.status, 'idle'); },
  };
  agents.set(root.id, root);
  let settingsRevision = 1;
  const currentTeamValue = { replacementRecords: {} };
  root.ctx.settings = {
    describe: () => [{ ns: 'dsh-native-current-team', revision: settingsRevision, value: clone(currentTeamValue) }],
    async mutate(ns, patches, expectedRevision) {
      assert.equal(ns, 'dsh-native-current-team');
      assert.equal(expectedRevision, settingsRevision);
      for (const patch of patches) {
        assert.equal(patch.op, 'set'); assert.equal(patch.path[0], 'replacementRecords');
        currentTeamValue.replacementRecords[patch.path[1]] = clone(patch.value);
      }
      settingsRevision++;
    },
  };
  const requireEnabled = () => { if (!enabled) throw nativeError('TEAM_DISABLED'); };
  const view = task => ({ ...clone(task), ready: task.status === 'pending'
    && task.blockedBy.every(id => tasks.get(id)?.status === 'completed'), writeScopeWarnings: [] });
  const ownTask = role => [...tasks.values()].find(task => new RegExp(role === 'implementer' ? '^Implement' : '^Review').test(task.subject));
  const board = {
    isEnabled: () => enabled,
    async setEnabled(agent, value, signal) {
      assert.equal(agent, root); signal?.throwIfAborted(); enabled = value;
      writes.push({ kind: 'mode', value }); order.push(`mode:${value}`);
      if (options.enableDrift && value) tasks.set('task-foreign', { id: 'task-foreign', revision: 1,
        subject: 'Foreign task', description: 'Unrelated work', status: 'pending', blockedBy: [], writeScopes: [] });
      if (options.enableCreateDelete && value) { await new Promise(resolve => setImmediate(resolve)); createDeleteForeign(); }
      if (options.restoreFlushDrift && !value) {
        await new Promise(resolve => setImmediate(resolve));
        [...tasks.values()][0].description = 'Concurrent restore-flush edit';
      }
      if (options.restoreFailure && !value) throw nativeError('FIXTURE_MODE_PERSISTENCE_FAILED');
      if (options.restoreModeMismatch && !value) enabled = true;
    },
    async createTask(agent, spec, signal) {
      requireEnabled(); assert.equal(agent, root); signal?.throwIfAborted();
      const task = { id: `task-${nextTask++}`, revision: 1, status: 'pending', blockedBy: [], writeScopes: [], ...clone(spec) };
      tasks.set(task.id, task); writes.push({ kind: 'create', taskId: task.id }); order.push(`create:${task.id}`);
      if (options.persistenceFailure && writes.filter(write => write.kind === 'create').length === 2) throw nativeError('TEAM_TASK_PERSISTENCE_UNCONFIRMED');
      return view(task);
    },
    getTask(_agent, id) { requireEnabled(); const task = tasks.get(id); if (!task) throw nativeError('TEAM_TASK_NOT_FOUND'); return view(task); },
    listTasks() { requireEnabled(); return [...tasks.values()].filter(task => task.status !== 'deleted').map(view); },
    async updateTask(agent, args, signal) {
      requireEnabled(); signal?.throwIfAborted(); const task = tasks.get(args.taskId);
      if (!task) throw nativeError('TEAM_TASK_NOT_FOUND');
      if (task.revision !== args.expectedRevision) throw nativeError('TEAM_TASK_STALE_REVISION');
      if (args.action === 'claim') {
        if ((task.ownerId !== undefined && task.ownerId !== agent.id) || !view(task).ready) throw nativeError('TEAM_TASK_BLOCKED');
        task.ownerId = agent.id; task.ownerName = children.get(agent.id)?.role; task.status = 'in_progress';
      } else if (args.action === 'reassign' && agent === root) {
        if (args.owner === undefined) { delete task.ownerId; delete task.ownerName; }
        else { task.ownerId = args.owner; task.ownerName = children.get(args.owner)?.role; }
      } else {
        if (task.ownerId !== agent.id || task.status !== 'in_progress') throw nativeError('TEAM_TASK_UNAUTHORIZED');
        if (args.action === 'edit') task.description = args.description;
        else if (args.action === 'complete') task.status = 'completed';
        else throw nativeError('TEAM_TASK_INVALID_TRANSITION');
      }
      task.revision++; writes.push({ kind: 'update', callerId: agent.id, taskId: task.id, action: args.action });
      return view(task);
    },
  };

  async function providerStep(child) {
    const schemas = await child.agent.ctx.tools.resolve({ agent: child.agent, modelSelection: child.route, signal: child.abort.signal });
    const input = { ...child.route, maxTokens: 1024, sessionId: child.agent.id,
      messages: [...child.history], tools: [...schemas.view(child.agent).keys()].map(name => ({ name, description: 'native fixture', parameters: {} })) };
    schemas.dispose();
    const provider = async function* () {
      providerCalls.push({ role: child.role, id: child.agent.id, route: child.route, tools: input.tools.map(tool => tool.name) });
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    let next = provider;
    for (const hook of [...hooks.get('llm/stream') ?? []].reverse()) { const previous = next; next = () => hook(input, previous); }
    for await (const _ of next()) {}
  }

  async function callTool(child, name, args) {
    if (options.modeDrift && !modeDrifted) { enabled = false; modeDrifted = true; order.push('foreign-mode:false'); }
    const callId = `call-${child.role}-${++child.callNumber}`;
    const exec = Object.freeze({ agent: child.agent, name, callId, rootCallId: callId,
      arguments: Object.freeze(clone(args)), signal: child.abort.signal });
    emit(child.hooks, 'session/event', child.agent.session, { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } });
    let decision = { kind: 'allow' }, failure;
    const downstream = async () => name === options.nativeDenyTool ? { kind: 'deny', reason: 'native permission refusal' }
      : !approvalUsed && child.role === 'implementer'
      && ((options.askTaskDrift && name === 'team_task_update' && args.action === 'claim')
        || (options.askPeerEnds && name === 'send_message')
        || name === options.askWorkTool) ? { kind: 'ask' } : { kind: 'allow' };
    const pres = [...child.hooks.get('tools/pre-execute') ?? []];
    const pre = index => index === pres.length ? downstream() : pres[index](exec, () => pre(index + 1));
    try {
      decision = await pre(0);
      if (decision.kind === 'ask') {
        approvalUsed = true; order.push('native-approval-wait');
        await new Promise(resolve => setImmediate(resolve));
        if (options.onApproval) await options.onApproval(exec);
        else if (options.askPeerEnds) {
          peerWaitTimeout.resolve();
          await [...children.values()].find(record => record.role === 'reviewer').agent.whenIdle();
        } else {
          const task = tasks.get(args.task_id); task.revision++; task.writeScopes.push('foreign-scope');
        }
        decision = { kind: 'allow' }; order.push('native-approval-allowed');
      }
      if (decision.kind === 'allow') {
        for (const guard of child.guards) { const denial = guard(exec); if (denial !== undefined) {
          decision = { kind: 'deny', reason: denial.reason ?? denial, info: denial.info }; break;
        } }
      }
      if (decision.kind !== 'allow') throw nativeError(decision.info?.code ?? 'NATIVE_POLICY_DENIED');
      exec.signal.throwIfAborted();
      if (!child.visible.has(name)) throw nativeError('UNKNOWN_TOOL');
      bodyCalls.push({ role: child.role, name, action: args.action });
      let value;
      if (name === 'team_task_get') value = board.getTask(child.agent, args.task_id);
      else if (name === 'team_task_update') value = await board.updateTask(child.agent, { taskId: args.task_id,
        expectedRevision: args.expected_revision, action: args.action, ...(args.description === undefined ? {} : { description: args.description }) }, exec.signal);
      else if (name === 'wait_agent') {
        await (options.sendPeerEndsAtResolve || options.askPeerEnds ? peerWaitTimeout.promise : peer.promise);
        value = { timedOut: options.sendPeerEndsAtResolve === true || options.askPeerEnds === true };
      }
      else if (name === 'send_message') {
        assert.equal(args.agent, 'reviewer');
        const recipient = [...children.values()].find(record => record.role === args.agent);
        if (!recipient) throw nativeError('TEAM_MEMBER_NOT_FOUND');
        if (options.sendPeerEndsAtResolve) {
          // Native body resolveName is asynchronous and follows finalGuard.
          // Let the peer finish its real wait/result/final stream in that seam.
          order.push('native-message-resolve-await'); peerWaitTimeout.resolve();
          await recipient.agent.whenIdle();
          order.push('native-message-resolve-return');
        }
        const message = { id: 'peer-owned-message', role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: child.agent.id },
          content: [{ type: 'text', text: 'Agent implementer sent a message: ' }, { type: 'text', text: args.message }] };
        recipient.agent.inbox.nextStep.push(message);
        emit(recipient.hooks, 'agent/inbox/inserted', { agent: recipient.agent, message }); peer.resolve();
        // Native control delivers to a working child, but wakes an idle child
        // into another run. An ended first lifecycle is not member absence.
        if (recipient.agent.status === 'idle') startNewWork(recipient, false, 'idle-message-wake');
        value = { messageId: message.id };
      } else if (typeof ctx.tools.definitions(child.agent).find(tool => tool.name === name)?.execute === 'function') {
        value = await ctx.tools.definitions(child.agent).find(tool => tool.name === name).execute(args, exec);
      }
      else throw nativeError('UNKNOWN_TOOL');
      const message = { id: `result-${callId}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
        isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] };
      child.history.push(message); emit(child.hooks, 'session/event', child.agent.session, { type: 'tool/result', data: { message } });
      return value;
    } catch (error) {
      failure = error;
      const message = { id: `result-${callId}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
        isError: true, content: [{ type: 'text', text: error.code ?? 'NATIVE_TOOL_FAILED' }] };
      child.history.push(message); emit(child.hooks, 'session/event', child.agent.session, { type: 'tool/result', data: { message, error: { name: 'NativeFixtureError', code: error.code ?? 'NATIVE_TOOL_FAILED' } } });
      throw failure;
    }
  }

  async function childWork(child) {
    const step = async (name, args) => { if (child.ended) throw nativeError('ALREADY_ENDED'); await providerStep(child); return callTool(child, name, args); };
    // Native AgentLoop appends turn/start once per turn, before its first step.
    // Multiple ordinary tool steps below remain inside this one turn.
    emit(child.hooks, 'session/event', child.agent.session, { type: 'turn/start', data: { turn: 1 } });
    order.push(`turn-start:${child.role}:1`);
    if (options.samePhaseSecondTurn && child.role === 'reviewer') {
      await step('team_task_get', { task_id: ownTask(child.role).id });
      emit(child.hooks, 'session/event', child.agent.session, { type: 'turn/start', data: { turn: 2 } });
      order.push(`turn-start:${child.role}:2`);
      try { await providerStep(child); } catch { /* hold actual lifecycle until explicit native settlement */ }
      order.push('same-phase-second-turn-return');
      return;
    }
    if (options.pendingStartup) { await providerStep(child); child.finish('completed'); return; }
    if (options.workCalls) {
      for (const call of options.workCalls(child.role, workspace)) await step(call.name, call.arguments);
      await providerStep(child); child.finish('completed'); return;
    }
    if (options.peerEndedBeforeSend && child.role === 'reviewer') { await providerStep(child); child.finish('completed'); return; }
    if (options.hang) {
      await step('team_task_get', { task_id: ownTask(child.role).id });
      return; // Native lifecycle intentionally remains unended until manual release.
    }
    if (child.role === 'reviewer') await step('wait_agent', { timeout_ms: 30000 });
    if ((options.sendPeerEndsAtResolve || options.askPeerEnds) && child.role === 'reviewer') { await providerStep(child); child.finish('completed'); return; }
    let task;
    if (child.role === 'reviewer') {
      await providerStep(child);
      const implementation = await callTool(child, 'team_task_get', { task_id: ownTask('implementer').id });
      assert.equal(implementation.status, 'completed');
      task = await callTool(child, 'team_task_get', { task_id: ownTask(child.role).id });
    } else task = await step('team_task_get', { task_id: ownTask(child.role).id });
    task = await step('team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'claim' });
    if (child.role === 'implementer') task = await step('team_task_update', { task_id: task.id, expected_revision: task.revision,
      action: 'edit', description: JSON.stringify({ runTag: config.runTag, role: 'implementer', value: 5 }) });
    task = await step('team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'complete' });
    if (child.role === 'implementer') await step('send_message', { agent: 'reviewer', message: JSON.stringify({
      runTag: config.runTag, implementationTaskId: task.id, value: 5 }) });
    await providerStep(child);
    child.finish('completed');
  }

  function startNewWork(child, replacement, cause) {
    const idle = deferred(), prior = child.agent;
    const resumed = !agents.has(prior.id);
    const current = replacement || resumed ? { ...prior, status: 'running' } : prior;
    current.status = 'running';
    const work = { id: current.id, agent: current, runId: `run-${child.role}-continuation-${newWork.length + 1}`,
      cause, replacement: replacement || resumed, settled: false, idle };
    const priorWhenIdle = current.whenIdle;
    current.whenIdle = async () => {
      order.push(`whenIdle-new:${work.runId}`);
      await idle.promise;
      if (current.status !== 'idle') return priorWhenIdle();
    };
    agents.set(current.id, current); catalog.get(current.id).activity = 'running';
    newWork.push(work); if (cause === 'idle-message-wake') wakeCalls++;
    order.push(`new-run:${work.runId}`);
    emit(hooks, 'subagent/start', { parentSessionId: root.id, id: current.id, runId: work.runId, provider: 'spawn', local: true });
    return work;
  }
  function settleNewWork(work) {
    if (work.settled) return;
    work.settled = true; work.agent.status = 'idle'; catalog.get(work.id).activity = 'inactive'; work.idle.resolve();
    if (!options.retainSettled && agents.get(work.id) === work.agent) agents.delete(work.id);
    order.push(`new-end:${work.runId}`);
    root.inbox.nextTurn.push({ id: `notice-${work.runId}`, source: { kind: 'subagent-settled', form: 'notice', senderSessionId: work.id }, content: [] });
    emit(hooks, 'subagent/end', { parentSessionId: root.id, id: work.id, runId: work.runId, provider: 'spawn', local: true, stopReason: 'aborted' });
  }

  async function spawn(input) {
    assert.equal(input.agent, root); assert.equal(input.calls.length, 1);
    const call = input.calls[0], args = JSON.parse(call.arguments), original = template.members.find(row => row.name === args.name);
    const member = options.sessionScopedPresets ? { ...original, agent_preset: args.agent_preset } : original;
    assert.equal(call.name, 'dsh_team_launcher_spawn'); assert.ok(member);
    const presetIds = options.sessionScopedPresets ? [...presets.keys()] : template.members.map(row => row.agent_preset);
    assert.deepEqual([...mount.spec.allowedAgentPresets].sort(), presetIds.sort());
    assert.equal(args.provider, member.provider); assert.equal(args.model, member.model); assert.equal(args.reasoning_effort, member.reasoning_effort);
    assert.equal(args.agent_preset, member.agent_preset);
    assert.equal(args.cwd, options.sessionScopedPresets ? effectiveWorkspace : workspace);
    assert.ok(args.prompt.includes(member.prompt)); assert.ok(!args.prompt.includes(member.persona_prompt));
    assert.ok(template.members.every(member => preflights.some(route => route.provider === member.provider
      && route.model === member.model && route.reasoningEffort === member.reasoning_effort)));
    if (options.unauthorized) throw nativeError('SESSION_ROUTE_NOT_AUTHORIZED');
    spawnAttempts++; order.push(`spawn:${member.name}`);
    if (options.failSecondCreate && spawnAttempts === 2) return { results: [{ callId: call.id,
      result: { isError: true, content: [{ type: 'text', text: 'Native creation failed' }], error: { message: 'Native creation failed', info: { name: 'NativeFixtureError', code: 'FIXTURE_CREATE_FAILED' } } } }], additionalContexts: [], concluded: false };
    if (options.lateStart && spawnAttempts === 1) { order.push('native-publication-await'); await latePublication.promise; }
    const definition = presets.get(member.agent_preset); assert.ok(definition);
    const localHooks = new Map(), guards = new Set(), restrictions = [], localTools = new Map(), ancestor = new Set(sharedTools.keys());
    const child = { role: member.name, callNumber: 0, hooks: localHooks, guards, history: [], abort: new AbortController(), idle: deferred(),
      localTools, route: { provider: args.provider, model: args.model, reasoningEffort: args.reasoning_effort }, ended: false, published: false };
    const id = `session-22222222-2222-4222-8222-${String(spawnAttempts).padStart(12, '0')}`;
    const agent = child.agent = { id, status: 'running', options: { maxTokens: mount.spec.agentOptions.maxTokens },
      async whenIdle() { order.push(`whenIdle-first:${member.name}`); await child.idle.promise; },
      // rc.2 inherits the initial project in metadata, then commits the requested effective cwd separately.
      session: { id, header: { origin: 'subagent', parentSession: root.id, cwd: root.session.header.cwd, agentPreset: member.agent_preset } },
      model: { current: () => child.route }, inbox: { nextStep: [], nextTurn: [] }, ctx: { preset: member.agent_preset, localTools,
        on: (name, fn) => listen(localHooks, name, fn), tools: {
          restrict(filter) {
            assert.ok(filter.allow.every(name => ancestor.has(name)), 'native restrict rejects unknown ancestor tools');
            restrictions.push([...filter.allow]); return () => {};
          },
          guard(fn) { guards.add(fn); return () => guards.delete(fn); },
          async resolve({ agent: caller, signal }) {
            assert.equal(caller, agent); assert.equal(child.published, true); signal.throwIfAborted();
            const visible = new Map([...ancestor].filter(name => restrictions.every(mask => mask.includes(name))).map(name => [name, {}]));
            for (const [name, definition] of localTools) if (restrictions.every(mask => mask.includes(name))) visible.set(name, definition);
            return { view: scope => scope === agent ? visible : new Map(), dispose() {} };
          },
        } } };
    for (const entry of definition.plugins) {
      if (entry.name === CONTROL.name) {
        assert.deepEqual(entry.config, { interrupt: false });
        ['send_message', 'wait_agent', 'list_agents'].forEach(name => ancestor.add(name));
      } else {
        assert.equal(entry.name, 'dsh-subagent-live-rc2-local/launcher-role');
        await applyLauncherRole({ tools: { ...ctx.tools,
          register(definition) { localTools.set(definition.name, definition); ancestor.add(definition.name);
            return () => localTools.delete(definition.name); } }, agents: ctx.agents,
          get: key => key === 'settings' ? root.ctx.settings : undefined,
          systemPrompt: { section(section) { child.persona = section.text; } },
          on: (name, fn) => listen(localHooks, name, fn) }, entry.config);
      }
    }
    emit(localHooks, 'agent/created', { agent });
    assert.equal(child.persona, member.persona_prompt);
    child.visible = new Set([...ancestor].filter(name => restrictions.every(mask => mask.includes(name))));
    assert.deepEqual([...child.visible].sort(), [...member.native_tool_allowlist].sort());
    child.finish = stopReason => {
      if (child.ended) return; child.ended = true; agent.status = 'idle';
      child.idle.resolve();
      // Native finishDisposal awaits AgentHandle.dispose (including registry
      // detach) before publishing the sole subagent/end. Catalog stays durable.
      if (!options.retainSettled) agents.delete(id);
      catalog.get(id).activity = 'inactive';
      const notice = { id: `notice-${member.name}`, source: { kind: 'subagent-settled', form: 'notice', senderSessionId: id }, content: [] };
      root.inbox.nextTurn.push(notice); order.push(`end:${member.name}`);
      emit(hooks, 'subagent/end', { parentSessionId: root.id, id, runId: `run-${member.name}`, provider: 'spawn', local: true,
        stopReason, lastAssistantMessage: [{ type: 'text', text: 'Startup finished.' }] });
      if ((options.externalNewRun || options.replaceAfterEnd) && children.size === 2
        && [...children.values()].every(row => row.ended) && newWork.length === 0) {
        startNewWork([...children.values()].find(row => row.role === 'reviewer'), options.replaceAfterEnd === true, 'external-continuation');
      }
    };
    childWorkspaces.set(id, options.childWorkspaceDrift ? join(args.cwd, 'unexpected-child-directory') : args.cwd);
    agents.set(id, agent); children.set(id, child); child.published = true;
    catalog.set(id, { kind: 'child', id, parentId: root.id, depth: 1, hasChildren: false, mode: 'continuable',
      activity: 'running', name: member.name, path: member.name, label: args.description });
    emit(hooks, 'subagent/start', { parentSessionId: root.id, id, runId: `run-${member.name}`, provider: 'spawn', local: true });
    if (released) queueMicrotask(() => child.finish('aborted'));
    else if (!options.lateStart) queueMicrotask(() => childWork(child).catch(() => child.finish('error')));
    return { results: [{ callId: call.id, result: { isError: false, value: { kind: 'activation', name: member.name }, content: [] } }], additionalContexts: [], concluded: false };
  }

  root.ctx.plugin = (module, spec) => {
    assert.equal(module, nativeSubagent); assert.equal(spec.modelSelection, true); assert.equal(spec.modelDiscovery, false);
    assert.equal(spec.maxDepth, 1); assert.equal(spec.agentOptions.maxTokens, 1024);
    const promise = Promise.resolve(); mount = { spec, live: true };
    promise.dispose = async () => { mount.live = false; order.push('native-tool-disposed'); }; return promise;
  };
  root.ctx.tools = {
    async resolve({ agent, signal }) { assert.equal(agent, root); signal.throwIfAborted();
      return { view: scope => scope === root && mount?.live ? new Map([[mount.spec.toolName, {}]]) : new Map(), dispose() {} }; },
    execute: spawn,
  };
  const nativeSubagent = { apply() {} };
  const ctx = {
    settings: root.ctx.settings,
    plugin(module) { return Promise.resolve(module.apply(ctx)); },
    tools: { definitions(scope) {
      const visible = new Map(sharedTools);
      if (scope === root) for (const [name, definition] of rootPresetTools) visible.set(name, definition);
      const local = children.get(scope?.id)?.localTools;
      if (local) for (const [name, definition] of local) visible.set(name, definition);
      // agent/created runs before publication into the native Agent registry.
      if (scope?.ctx?.localTools) for (const [name, definition] of scope.ctx.localTools) visible.set(name, definition);
      const definitions = [...visible.values()];
      return options.toolDefinitions ? options.toolDefinitions(scope, definitions) : definitions;
    }, executable(name, scope) { return this.definitions(scope).find(tool => tool.name === name); } },
    workingDirectory: {
      get(session) { return session.id === root.id ? effectiveWorkspace : childWorkspaces.get(session.id) ?? session.header.cwd; },
      async set(agent, cwd) { assert.equal(agent, root); effectiveWorkspace = cwd; return cwd; },
    },
    agents: { get: id => agents.get(id) }, agentTeams: board,
    sessionProjections: { stateOf(_session, key) {
      if (key === 'agentTeam') return { ...(enabled ? { enabled: true } : options.rawEnabledMissing ? {} : { enabled: false }),
        id: root.id, inheritedEventCount: 0, tasks: [...tasks.values()].map(clone), nextTaskNumber: nextTask };
      if (key === 'subagentModelSelectionPolicy') return options.unauthorized ? [] : template.members.map(member => ({ provider: member.provider, model: member.model }));
    } },
    llm: { async resolveCallConfig(route, signal) { signal.throwIfAborted(); preflights.push(clone(route)); order.push(`preflight:${route.model}`);
      if (options.resolveCallConfig) return options.resolveCallConfig(route, signal);
      if (options.preflightUnexpected && preflights.length === 1) {
        await new Promise(resolve => setImmediate(resolve));
        emit(hooks, 'subagent/start', { parentSessionId: root.id, id: 'unexpected-child', runId: 'unexpected-run', provider: 'spawn', local: true });
      }
      return options.resolvedCapDrift ? { ...route, maxTokens: undefined } : route; } },
    subagents: {
      namesOf(agent) { const child = children.get(agent.id); assert.ok(child); return { self: child.role, parent: 'lead', root: 'lead' }; },
      async listDescendants(id, signal) { assert.equal(id, root.id); signal?.throwIfAborted(); return [...catalog.values()].map(clone); },
      interrupt(id, auth) { assert.equal(auth.agent, root); assert.equal(auth.kind, 'ancestor'); order.push(`interrupt:${id}`);
        // Native manager validates the ancestor, then returns void when no
        // resident activation exists. Registry absence is not NOT_FOUND here.
        const child = children.get(id), activeWork = newWork.some(work => work.id === id && !work.settled);
        if ((!child || child.ended) && !activeWork) return;
        if (options.throwInterrupt) throw nativeError('FIXTURE_INTERRUPT_FAILED');
        for (const work of newWork.filter(work => work.id === id && !work.settled)) settleNewWork(work);
        if (child && !child.ended) { child.abort.abort(nativeError('ABORTED')); peer.resolve(); if (!options.hang) child.finish('aborted'); }
      },
    },
    agentPresets: {
      async register(definition) { assert.equal(presets.has(definition.id), false); presets.set(definition.id, definition); createdPresets.push(definition.id);
        return async () => { presets.delete(definition.id); removedPresets.push(definition.id); }; },
      composedPreset: scope => scope.preset,
    },
    on: (name, fn) => owner.on(hooks, name, fn),
    commands: { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name); } },
    effect: owner.effect,
  };
  const dispose = async () => { if (disposed) return owner.dispose(); disposed = true; return owner.dispose(); };
  const release = () => { released = true; latePublication.resolve(); peer.resolve(); peerWaitTimeout.resolve(); for (const child of children.values()) child.finish('aborted');
    for (const work of newWork) settleNewWork(work); };
  t.after(async () => {
    release();
    try {
      if (!options.cleanupTimeoutMs) await dispose();
      else {
        let timer;
        try { await Promise.race([dispose(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(nativeError('FIXTURE_UNLOAD_DRAIN_TIMEOUT')), options.cleanupTimeoutMs);
        })]); } finally { clearTimeout(timer); }
      }
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
  await applyLauncher(ctx, config, nativeSubagent, CONTROL);
  return { ctx, config, template, root, board, hooks, tasks, catalog, agents, presets, children, order, writes, bodyCalls,
    providerCalls, preflights, createdPresets, removedPresets, noticesRemoved, release, dispose, newWork, createDeleteForeign,
    publishLateStart: () => latePublication.resolve(),
    requestChildStream: id => providerStep(children.get(id)),
    emitWrongRunEnd(id) { emit(hooks, 'subagent/end', { parentSessionId: root.id, id, runId: 'wrong-run',
      provider: 'spawn', local: true, stopReason: 'aborted' }); },
    invoke: (command, extra = {}) => commands.get(options.commandName ?? 'dsh-team-launcher').handler({ agent: root, rawInput: command,
      attachments: [], signal: new AbortController().signal, ...extra }),
    counts: () => ({ spawnAttempts, wakeCalls, taskCreates: writes.filter(write => write.kind === 'create').length,
      modeWrites: writes.filter(write => write.kind === 'mode').length, providerCalls: providerCalls.length }),
  };
}
