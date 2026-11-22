import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../launcher-role.js';

const TOOLS = ['team_task_get', 'team_task_update', 'send_message', 'wait_agent', 'write'];
const example = () => ({ ownedSessionId: 'session-20000000-0000-4000-8000-000000000002',
  roleName: 'implementer', personaPrompt: '按任务要求实现，并给出可核对的结果。\n保留这段原文与 {{literal_placeholder}}。',
  tools: ['team_task_get', 'team_task_update', 'send_message'] });
const hasCode = code => error => error.code === code && error.message === code && error.name === 'LauncherRoleError';

// Only the public context ownership contract is synthetic; no Host, Session or provider is started.
function fixture() {
  const sections = new Map(), hooks = new Set(), hookEvents = new Map(), presetDisposers = [], tasks = new Map();
  const definitions = TOOLS.map(name => ({ name }));
  let rows = [], readError, childOrdinal = 0;
  const root = { id: example().ownedSessionId, session: { id: example().ownedSessionId, header: {} },
    ctx: { settings: { describe() { if (readError) throw readError; return rows; } } } };
  const agents = new Map([[root.id, root]]);
  const ctx = {
    get: key => key === 'settings' ? root.ctx.settings : key === 'agentTeams' ? {
      getTask(_root, id) { if (!tasks.has(id)) throw new Error('task unavailable'); return tasks.get(id); },
    } : undefined,
    agents: { get: id => agents.get(id) }, tools: { definitions: () => definitions },
    systemPrompt: { section(section) {
      sections.set(section.name, section);
      const dispose = () => sections.delete(section.name); presetDisposers.push(dispose); return dispose;
    } },
    on(event, callback) {
      assert.ok(['agent/created', 'agent/pre-step'].includes(event)); hooks.add(callback); hookEvents.set(callback, event);
      const dispose = () => { hooks.delete(callback); hookEvents.delete(callback); }; presetDisposers.push(dispose); return dispose;
    },
  };
  const makeAgent = ({ id = `session-30000000-0000-4000-8000-${String(++childOrdinal).padStart(12, '0')}`,
    origin = 'subagent', parentSession = example().ownedSessionId, known = TOOLS } = {}) => {
    const restrictions = [], guards = [], childDisposers = [], childHooks = [];
    const agent = { id, session: { id, header: { origin, parentSession } }, ctx: {
      on(event, callback) {
        childHooks.push({ event, callback });
        const dispose = () => childHooks.splice(childHooks.findIndex(entry => entry.callback === callback), 1);
        childDisposers.push(dispose); return dispose;
      },
      tools: {
      guard(callback) {
        guards.push(callback); const dispose = () => guards.splice(guards.indexOf(callback), 1);
        childDisposers.push(dispose); return dispose;
      },
      restrict(filter) {
        assert.ok(filter.allow.every(tool => known.includes(tool)), 'native unknown-name restriction');
        const mask = { allow: [...filter.allow] }; restrictions.push(mask);
        const dispose = () => restrictions.splice(restrictions.indexOf(mask), 1); childDisposers.push(dispose); return dispose;
      },
    } } };
    agents.set(id, agent);
    return { agent, restrictions, guards,
      guard(name, args = {}) {
        const exec = { agent, name, arguments: args, callId: `call-${name}`, toolSet: {} };
        for (const callback of guards) { const denial = callback(exec); if (denial !== undefined) return denial; }
      },
      async prestep(payload = {}) {
        const chain = childHooks.filter(entry => entry.event === 'agent/pre-step').map(entry => entry.callback);
        const run = async index => index >= chain.length ? { kind: 'enter' }
          : chain[index]({ agent, ...payload }, () => run(index + 1));
        return run(0);
      },
      dispose() {
        agents.delete(id);
        for (const dispose of childDisposers.splice(0).reverse()) dispose();
      } };
  };
  return { ctx, root, agents, sections, hooks, makeAgent,
    setTask(task) { tasks.set(task.id, task); },
    setRecord(value) { this.setNativeRecord(value); },
    setNativeRecord(value) { rows = [{ ns: 'dsh-native-current-team', revision: 1,
      value: { replacementRecords: { [root.id]: value ?? { version: 1, operations: [] } } } }]; },
    clearPartition() { rows = [{ ns: 'dsh-native-current-team', revision: 2, value: { replacementRecords: {} } }]; },
    clearRecord() { rows = []; },
    setReadError(error) { readError = error; },
    created: payload => { for (const callback of hooks) if (hookEvents.get(callback) === 'agent/created') callback(payload); },
    prestep: async payload => {
      const chain = [...hooks].filter(callback => hookEvents.get(callback) === 'agent/pre-step');
      const run = async index => index >= chain.length ? undefined : chain[index](payload, () => run(index + 1));
      return run(0);
    },
    dispose() { for (const dispose of presetDisposers.splice(0).reverse()) dispose(); } };
}

test('launcher persona is the exact supplied section and each role gets its own native mask', async () => {
  for (const config of [example(), { ...example(), roleName: 'reviewer', personaPrompt: '独立核对证据，明确给出审查结论。',
    tools: ['team_task_get', 'team_task_update', 'wait_agent'] }]) {
    const h = fixture(); await apply(h.ctx, config);
    assert.deepEqual(h.sections.get('deployment:persona-prefix'), { name: 'deployment:persona-prefix', order: 0,
      text: config.personaPrompt, interpolate: false });
    const child = h.makeAgent(); h.created({ agent: child.agent });
    assert.deepEqual(child.restrictions, [{ allow: config.tools }]); child.dispose(); h.dispose();
  }
});

test('pre-step is waterfall middleware: allowed path must invoke next()', async () => {
  const h = fixture();
  h.setRecord(undefined);
  await apply(h.ctx, example());
  const child = h.makeAgent({ id: 'session-8ad8c6c8-3fb8-4f93-800a-9a8b3870abaf' });
  h.created({ agent: child.agent });
  const allowed = await h.prestep({ agent: child.agent, messages: [], turn: 1, step: 1,
    signal: new AbortController().signal, modelSelection: {} });
  assert.equal(allowed, undefined);
});

test('pre-step rejects a frozen old member from the durable record', async () => {
  const h = fixture();
  const OLD = 'session-8ad8c6c8-3fb8-4f93-800a-9a8b3870abaf';
  const { startReplacement, readReplacementRecord } = await import('../src/member-replacement.js');
  const { record } = startReplacement(readReplacementRecord(undefined),
    { role: 'implementer', oldChildId: OLD, handoffDigest: 'a'.repeat(64), taskRefs: [] });
  h.setRecord(record);
  await apply(h.ctx, example());
  const child = h.makeAgent({ id: OLD });
  h.created({ agent: child.agent });
  const decision = await h.prestep({ agent: child.agent, messages: [], turn: 2, step: 1,
    signal: new AbortController().signal, modelSelection: {} });
  assert.deepEqual(decision, { kind: 'reject' });
  // corrupt record must also deny, never fall back to full
  h.setRecord({ version: 9 });
  const corrupt = await h.prestep({ agent: child.agent, messages: [], turn: 3, step: 1,
    signal: new AbortController().signal, modelSelection: {} });
  assert.deepEqual(corrupt, { kind: 'reject' });
});

test('native profile root partition retires an old member before its first model step or tool body', async () => {
  const h = fixture(), OLD = 'session-90000000-0000-4000-8000-000000000001';
  const { startReplacement, readReplacementRecord } = await import('../src/member-replacement.js');
  const { record } = startReplacement(readReplacementRecord(undefined), {
    role: 'implementer', oldChildId: OLD, handoffDigest: 'a'.repeat(64), taskRefs: [],
  });
  h.setNativeRecord(record);
  await apply(h.ctx, example());
  const child = h.makeAgent({ id: OLD }); h.created({ agent: child.agent });
  assert.deepEqual(await child.prestep(), { kind: 'reject' });
  assert.equal(child.guard('team_task_update', {})?.reason, 'TEAM_MEMBER_RETIRED');
});

test('managed Presets fail closed on cold startup before the native owner or root partition is visible', async () => {
  for (const state of ['owner-not-active', 'partition-missing', 'read-failed', 'ready']) {
    const h = fixture();
    if (state === 'partition-missing') h.clearPartition();
    if (state === 'read-failed') h.setReadError(new Error('startup read unavailable'));
    if (state === 'ready') h.setNativeRecord({ version: 1, operations: [] });
    await apply(h.ctx, { ...example(), replacementOwner: 'dsh-native-current-team' });
    const child = h.makeAgent(); h.created({ agent: child.agent });
    assert.deepEqual(await child.prestep(), { kind: state === 'ready' ? 'enter' : 'reject' }, state);
    assert.equal(child.guard('team_task_update', {})?.reason,
      state === 'ready' ? undefined : 'TEAM_ELIGIBILITY_UNVERIFIABLE', state);
  }
});

test('a candidate awaiting takeover proof loses admission when native task ownership changes', async () => {
  const h = fixture(), OLD = 'session-90000000-0000-4000-8000-000000000011';
  const { startReplacement, readReplacementRecord, transitionReplacement, verifyReadinessAck,
    replacementCandidateOf, recordOwnerWriteAttempt, recordTaskOutcome } = await import('../src/member-replacement.js');
  const started = startReplacement(readReplacementRecord(undefined), { role: 'implementer', oldChildId: OLD,
    handoffDigest: 'b'.repeat(64), taskRefs: [{ taskId: 'task-1', revision: 1 }],
    instanceName: 'implementer-r1', candidateConfig: JSON.stringify({ role: 'implementer', provider: 'fixture',
      model: 'local', personaPrompt: 'Continue the task.', prompt: 'Continue.', tools: ['write', 'team_task_update'] }) }, 1);
  const childId = replacementCandidateOf(started.record.operations[0]).childId;
  let record = transitionReplacement(started.record, started.operationId, 'standby', 2, { newChildId: childId });
  const op = record.operations[0];
  const ack = verifyReadinessAck({ text: JSON.stringify({ ready: true, operation: op.id,
    handoff: op.handoffDigest, config: op.configDigest }), senderSessionId: childId, operation: op, at: 3 });
  record = transitionReplacement(record, op.id, 'ready', 3, { readinessAck: ack.evidence });
  record = transitionReplacement(record, op.id, 'transferring', 4);
  record = recordOwnerWriteAttempt(record, op.id, 'task-1', 1, 5);
  record = recordTaskOutcome(record, op.id, { taskId: 'task-1', kind: 'transferred', revision: 2 }, 6);
  record = transitionReplacement(record, op.id, 'activating', 7);
  h.setRecord(record); h.setTask({ id: 'task-1', ownerId: childId, revision: 2, status: 'in_progress' });
  await apply(h.ctx, { ...example(), tools: ['write', 'team_task_update'], standbyOperationId: op.id,
    replacementOwner: 'dsh-native-current-team' });
  const child = h.makeAgent({ id: childId }); h.created({ agent: child.agent });
  assert.equal(child.guard('write', {}), undefined);
  h.setTask({ id: 'task-1', ownerId: OLD, revision: 3, status: 'in_progress' });
  assert.equal(child.guard('write', {})?.reason, 'TEAM_TASK_OWNERSHIP_CHANGED');
  assert.deepEqual(await child.prestep(), { kind: 'reject' });
});

test('a born-Standby candidate gets only snapshot-bound task reads and the exact Lead ACK', async () => {
  const h = fixture(), OLD = 'session-40000000-0000-4000-8000-000000000001';
  const CANDIDATE = 'session-40000000-0000-4000-8000-000000000002';
  const { startReplacement, readReplacementRecord, transitionReplacement } = await import('../src/member-replacement.js');
  const started = startReplacement(readReplacementRecord(undefined), { role: 'implementer', oldChildId: OLD,
    handoffDigest: 'b'.repeat(64), taskRefs: [{ taskId: 'task-1', revision: 7 }] });
  h.setRecord(started.record);
  await apply(h.ctx, { ...example(), tools: ['write'], standbyOperationId: started.operationId });
  const child = h.makeAgent({ id: CANDIDATE }); h.created({ agent: child.agent });
  assert.deepEqual(child.restrictions, [{ allow: ['write', 'team_task_get', 'send_message'] }]);
  assert.deepEqual(await child.prestep(), { kind: 'enter' }, 'Standby may run the bounded readiness turn');
  assert.equal(child.guard('team_task_get', { task_id: 'task-1' }), undefined);
  assert.equal(child.guard('send_message', { agent: 'lead', message: JSON.stringify({ ready: true,
    operation: started.operationId, handoff: 'b'.repeat(64) }) }), undefined);
  for (const [name, args] of [
    ['write', {}],
    ['team_task_get', { task_id: 'task-2' }],
    ['team_task_get', { task_id: 'task-1', extra: true }],
    ['send_message', { agent: 'reviewer', message: JSON.stringify({ ready: true,
      operation: started.operationId, handoff: 'b'.repeat(64) }) }],
    ['send_message', { agent: 'lead', message: JSON.stringify({ ready: true,
      operation: started.operationId, handoff: 'c'.repeat(64) }) }],
  ]) assert.equal(child.guard(name, args)?.reason, 'TEAM_STANDBY_RESTRICTED');

  let active = transitionReplacement(started.record, started.operationId, 'standby', Date.now() + 1,
    { newChildId: CANDIDATE });
  active = transitionReplacement(active, started.operationId, 'ready', Date.now() + 2);
  active = transitionReplacement(active, started.operationId, 'transferring', Date.now() + 3);
  active = transitionReplacement(active, started.operationId, 'active', Date.now() + 4);
  h.setRecord(active);
  assert.equal(child.guard('write', {}), undefined, 'activation grants the configured work tool');
  assert.equal(child.guard('team_task_get', { task_id: 'task-1' })?.reason, 'TEAM_TOOL_OUT_OF_SCOPE',
    'standby transport is not retained as active authority when it was not requested');
});

test('known retirement stays denied across projection loss and registry identity changes', async () => {
  const h = fixture(), OLD = 'session-50000000-0000-4000-8000-000000000001';
  const { startReplacement, readReplacementRecord } = await import('../src/member-replacement.js');
  const { record } = startReplacement(readReplacementRecord(undefined),
    { role: 'implementer', oldChildId: OLD, handoffDigest: 'd'.repeat(64), taskRefs: [] });
  h.setRecord(record); await apply(h.ctx, example());
  const child = h.makeAgent({ id: OLD }); h.created({ agent: child.agent });
  assert.equal(child.guard('team_task_get', {})?.reason, 'TEAM_MEMBER_RETIRED');
  assert.deepEqual(await child.prestep(), { kind: 'reject' });
  h.clearRecord();
  assert.equal(child.guard('team_task_get', {})?.reason, 'TEAM_ELIGIBILITY_UNVERIFIABLE');
  h.setRecord(record); h.setReadError(new Error('settings unavailable'));
  assert.equal(child.guard('team_task_get', {})?.reason, 'TEAM_ELIGIBILITY_UNVERIFIABLE');
  h.setReadError(undefined); h.agents.set(OLD, { id: OLD });
  assert.deepEqual(await h.prestep({ agent: child.agent }), { kind: 'reject' });
  h.agents.set(OLD, child.agent);
  h.agents.set(h.root.id, { ...h.root });
  assert.deepEqual(await h.prestep({ agent: child.agent }), { kind: 'reject' });
});

test('membership gates readiness tools, failed continuation and direct prompts after removal', async () => {
  const { readReplacementRecord, ensureReplacementBaseBinding, withMembership } = await import('../src/member-replacement.js');
  const { appendAddition, settleAddition, appendRemoval } = await import('../src/member-roster.js');
  const h = fixture(), config = { ...example(), replacementOwner: 'dsh-native-current-team' };
  const pending = appendAddition([], { name: 'implementer', member: { name: 'implementer', agent_preset: 'dsh-added' } });
  const base = ensureReplacementBaseBinding(readReplacementRecord(undefined), JSON.stringify({ workspace: '/w', template: {} }));
  h.setRecord(withMembership(base, pending.membership));
  await apply(h.ctx, config);
  const child = h.makeAgent({ id: pending.entry.childId }); h.created({ agent: child.agent });
  assert.deepEqual(await child.prestep(), { kind: 'enter' });
  assert.equal(child.guard('team_task_update', {})?.reason, 'TEAM_MEMBER_STARTING');
  h.setRecord(withMembership(base, settleAddition(pending.membership, pending.entry.id, 'active')));
  assert.equal(child.guard('team_task_update', {}), undefined);
  h.setRecord(withMembership(base, settleAddition(pending.membership, pending.entry.id, 'failed')));
  assert.deepEqual(await child.prestep(), { kind: 'reject' });
  h.setRecord(withMembership(base, appendRemoval([], { name: 'implementer', childId: child.agent.id }).membership));
  assert.deepEqual(await child.prestep(), { kind: 'reject' });
  assert.equal(child.guard('team_task_get', {})?.reason, 'TEAM_MEMBER_REMOVED');
});

test('launcher role freezes accepted persona and tools instead of following later config edits', async () => {
  const config = example(), original = structuredClone(config), h = fixture(); await apply(h.ctx, config);
  config.personaPrompt = 'later replacement'; config.ownedSessionId = 'other-root'; config.tools.push('wait_agent');
  const child = h.makeAgent(); h.created({ agent: child.agent });
  assert.equal(h.sections.get('deployment:persona-prefix').text, original.personaPrompt);
  assert.deepEqual(child.restrictions, [{ allow: original.tools }]); child.dispose(); h.dispose();
});

test('an explicit empty subset installs the native empty allow mask', async () => {
  const h = fixture(); await apply(h.ctx, { ...example(), roleName: 'observer', tools: [] });
  const child = h.makeAgent(); h.created({ agent: child.agent }); assert.deepEqual(child.restrictions, [{ allow: [] }]);
  child.dispose(); h.dispose();
});

test('wrong origin or parent refuses before any tool restriction', async () => {
  const h = fixture(); await apply(h.ctx, example());
  for (const origin of ['user', 'root', undefined]) {
    const child = h.makeAgent(); child.agent.session.header.origin = origin;
    assert.throws(() => h.created({ agent: child.agent }), hasCode('LAUNCHER_ROLE_WRONG_ORIGIN')); assert.deepEqual(child.restrictions, []);
  }
  const other = h.makeAgent({ parentSession: 'other-root' });
  assert.throws(() => h.created({ agent: other.agent }), hasCode('LAUNCHER_ROLE_WRONG_PARENT')); assert.deepEqual(other.restrictions, []);
  assert.throws(() => h.created(undefined), hasCode('LAUNCHER_ROLE_WRONG_ORIGIN')); h.dispose();
});

test('strict config rejects unknown or missing fields without installing context contributions', async () => {
  const accessor = { ...example() }; Object.defineProperty(accessor, 'personaPrompt', { get() { throw new Error('private prompt'); } });
  for (const config of [null, [], {}, { ...example(), nonce: 'unrequested' }, { ...example(), budget: 1 },
    Object.fromEntries(Object.entries(example()).filter(([key]) => key !== 'roleName')), accessor,
    { ...example(), [Symbol('extra')]: true }]) {
    const h = fixture(); await assert.rejects(apply(h.ctx, config), hasCode('LAUNCHER_ROLE_INVALID_CONFIG'));
    assert.equal(h.sections.size, 0); assert.equal(h.hooks.size, 0);
  }
});

test('owner, role and persona have finite validated values', async () => {
  for (const [key, values, code] of [
    ['ownedSessionId', ['', 'x'.repeat(129), 'root with spaces', null], 'LAUNCHER_ROLE_INVALID_OWNER'],
    ['roleName', ['', 'lead', 'Bad Name', 'x'.repeat(33), null], 'LAUNCHER_ROLE_INVALID_NAME'],
    ['personaPrompt', ['', ' \n\t', 'x'.repeat(16385), 'before\0after', {}], 'LAUNCHER_ROLE_INVALID_PERSONA'],
  ]) for (const value of values) await assert.rejects(apply(fixture().ctx, { ...example(), [key]: value }), hasCode(code));
  const h = fixture(); await apply(h.ctx, { ...example(), ownedSessionId: 'x'.repeat(128), roleName: 'x'.repeat(32), personaPrompt: 'x'.repeat(16384) }); h.dispose();
});

test('role tool names are explicit and unique, with orchestration capabilities excluded', async () => {
  for (const tools of [undefined, 'send_message', ['spawn_agent'], ['team_task_get', 'team_task_get'],
    ['team_task_list'], [...TOOLS, 'run_code'], ['plugin_manager'], ['workflow'], ['ralph'], ['subagent_fork'], [null], Array(1)]) {
    await assert.rejects(apply(fixture().ctx, { ...example(), tools }), hasCode('LAUNCHER_ROLE_INVALID_TOOLS'));
  }
  const h = fixture(); await apply(h.ctx, { ...example(), tools: ['read', 'bash'] }); h.dispose();
});

test('missing or failed native restriction emits a stable code without leaking persona or native errors', async () => {
  const sensitive = 'SENSITIVE_PERSONA_DO_NOT_ECHO', h = fixture(); await apply(h.ctx, { ...example(), personaPrompt: sensitive });
  const child = h.makeAgent(); child.agent.ctx.tools.restrict = () => { throw new Error(sensitive); };
  assert.throws(() => h.created({ agent: child.agent }), error => hasCode('LAUNCHER_ROLE_TOOLS_UNAVAILABLE')(error) && !String(error).includes(sensitive));
  delete child.agent.ctx.tools.restrict;
  assert.throws(() => h.created({ agent: child.agent }), hasCode('LAUNCHER_ROLE_TOOLS_UNAVAILABLE'));
  await assert.rejects(apply(h.ctx, { ...example(), personaPrompt: sensitive, extra: true }), error =>
    hasCode('LAUNCHER_ROLE_INVALID_CONFIG')(error) && !String(error).includes(sensitive)); h.dispose();
});

test('native context disposal removes persona and hooks, and child disposal removes only its mask', async () => {
  const h = fixture(); await apply(h.ctx, example()); const child = h.makeAgent(); h.created({ agent: child.agent });
  assert.equal(h.sections.size, 1); assert.equal(h.hooks.size, 2); assert.equal(child.restrictions.length, 1);
  child.dispose(); assert.equal(child.restrictions.length, 0); assert.equal(h.sections.size, 1);
  h.dispose(); assert.equal(h.sections.size, 0); assert.equal(h.hooks.size, 0);
  const later = h.makeAgent(); h.created({ agent: later.agent }); assert.deepEqual(later.restrictions, []);
});
