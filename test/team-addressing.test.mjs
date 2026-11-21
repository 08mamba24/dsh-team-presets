import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogicalAgentTeams,
  createLogicalSubagents,
  isReusableLogicalTeamTaskDelegate,
  projectLogicalTeamDescendants,
  projectLogicalTeamAgents,
  projectLogicalTeamName,
  registerReusableLogicalTeamTaskDelegate,
  resolveLogicalTeamTarget,
} from '../src/team-addressing.js';
import {
  currentRoleOwner,
  readReplacementRecord,
  replacementCandidateOf,
  startReplacement,
  transitionReplacement,
} from '../src/member-replacement.js';
import { registerLauncherPresets } from '../src/launcher-native.js';
import { REPLACEMENT_OWNER } from '../src/replacement-store.js';
import { CONTROL } from './fixtures/control-entry.mjs';

const OLD_IMPLEMENTER = '11111111-1111-4111-8111-111111111111';
const OLD_REVIEWER = '22222222-2222-4222-8222-222222222222';
const CORDIS_ORIGINAL = Symbol.for('cordis.original');
const CORDIS_TRACKER = Symbol.for('cordis.tracker');
const traceableService = target => new Proxy(target, {
  get(inner, property, receiver) {
    if (property === CORDIS_ORIGINAL) return inner;
    return Reflect.get(inner, property, receiver);
  },
});
const request = role => ({
  role,
  provider: 'fixture-provider',
  model: 'fixture-model',
  reasoningEffort: 'max',
  personaPrompt: `Act as ${role}.`,
  prompt: `Start as ${role}.`,
  tools: ['team_task_get', 'team_task_update', 'send_message'],
  progressFacts: 'No prior progress.',
});

test('only an exact logical task delegate may use the conditional reuse contract', () => {
  const lookalike = Object.freeze({ name: 'team_task_get', execute() {} });
  assert.equal(isReusableLogicalTeamTaskDelegate(lookalike), false);
  assert.throws(() => registerReusableLogicalTeamTaskDelegate({ tools: { register() {} } }, lookalike),
    { code: 'TEAM_ADDRESS_NATIVE_CONTROL_UNAVAILABLE' });
});

function begin(record, role, oldChildId, instanceName) {
  return startReplacement(record, {
    role,
    oldChildId,
    handoffDigest: 'a'.repeat(64),
    taskRefs: [],
    handoffText: `handoff for ${role}`,
    candidateConfig: JSON.stringify(request(role)),
    instanceName,
  }, 1);
}

function move(record, operationId, phase) {
  const operation = record.operations.find(entry => entry.id === operationId);
  if (phase === 'standby') {
    return transitionReplacement(record, operationId, phase, 2, {
      newChildId: replacementCandidateOf(operation).childId,
    });
  }
  if (phase === 'ready') {
    return transitionReplacement(record, operationId, phase, 3, {
      readinessAck: {
        senderSessionId: operation.newChildId,
        handoffDigest: operation.handoffDigest,
        configDigest: operation.configDigest,
        at: 3,
      },
    });
  }
  if (phase === 'active') {
    return transitionReplacement(record, operationId, phase, 6, {
      takeoverProof: { kind: 'not-required', reason: 'no-unfinished-tasks', at: 6 },
    });
  }
  const at = phase === 'transferring' ? 4 : 5;
  return transitionReplacement(record, operationId, phase, at);
}

function activate(record, operationId) {
  for (const phase of ['standby', 'ready', 'transferring', 'activating', 'active']) {
    record = move(record, operationId, phase);
  }
  return record;
}

test('stable role and descendant paths address the first and second active replacement', () => {
  let record = readReplacementRecord();
  const first = begin(record, 'implementer', OLD_IMPLEMENTER, 'implementer-r2');
  record = activate(first.record, first.operationId);
  const firstOwner = currentRoleOwner(record, 'implementer');
  assert.equal(resolveLogicalTeamTarget(record, 'implementer'), firstOwner);
  assert.equal(resolveLogicalTeamTarget(record, 'implementer/checker'), 'implementer-r2/checker');

  const second = begin(record, 'implementer', firstOwner, 'implementer-r3');
  record = activate(second.record, second.operationId);
  const secondOwner = currentRoleOwner(record, 'implementer');
  assert.notEqual(secondOwner, firstOwner);
  assert.equal(resolveLogicalTeamTarget(record, 'implementer'), secondOwner);
  assert.equal(resolveLogicalTeamTarget(record, 'implementer/checker'), 'implementer-r3/checker');
  assert.throws(() => resolveLogicalTeamTarget(record, firstOwner), { code: 'TEAM_MEMBER_RETIRED' });
  assert.throws(() => resolveLogicalTeamTarget(record, 'implementer-r2'), { code: 'TEAM_PHYSICAL_ADDRESS_FORBIDDEN' });
});

test('every nonterminal replacement phase fails closed instead of routing to the frozen owner', () => {
  for (const wanted of ['frozen', 'standby', 'ready', 'transferring', 'activating', 'recovering', 'cancelling']) {
    let record = readReplacementRecord();
    const started = begin(record, 'reviewer', OLD_REVIEWER, 'reviewer-r2');
    record = started.record;
    if (wanted !== 'frozen') {
      for (const phase of ['standby', 'ready', 'transferring', 'activating']) {
        record = move(record, started.operationId, phase);
        if (phase === wanted) break;
      }
      if (wanted === 'recovering') record = transitionReplacement(record, started.operationId, 'recovering', 6);
      if (wanted === 'cancelling') {
        record = readReplacementRecord();
        const fresh = begin(record, 'reviewer', OLD_REVIEWER, 'reviewer-r2');
        record = transitionReplacement(fresh.record, fresh.operationId, 'cancelling', 2);
      }
    }
    assert.equal(record.operations.at(-1).phase, wanted);
    assert.throws(() => resolveLogicalTeamTarget(record, 'reviewer'), { code: 'TEAM_ROLE_ADDRESS_UNAVAILABLE' });
    assert.throws(() => resolveLogicalTeamTarget(record, OLD_REVIEWER), { code: 'TEAM_MEMBER_RETIRED' });
  }
});

test('aborted replacement restores the prior active generation and never exposes its cancelled candidate', () => {
  let record = readReplacementRecord();
  const first = begin(record, 'implementer', OLD_IMPLEMENTER, 'implementer-r2');
  record = activate(first.record, first.operationId);
  const current = currentRoleOwner(record, 'implementer');
  const second = begin(record, 'implementer', current, 'implementer-r3');
  record = transitionReplacement(second.record, second.operationId, 'cancelling', 7);
  record = transitionReplacement(record, second.operationId, 'aborted', 8);
  assert.equal(resolveLogicalTeamTarget(record, 'implementer'), current);
  assert.equal(resolveLogicalTeamTarget(record, 'implementer/checker'), 'implementer-r2/checker');
  assert.throws(() => resolveLogicalTeamTarget(record, replacementCandidateOf(second.record.operations.at(-1)).childId),
    { code: 'TEAM_MEMBER_RETIRED' });
  assert.throws(() => resolveLogicalTeamTarget(record, 'implementer-r3'), { code: 'TEAM_PHYSICAL_ADDRESS_FORBIDDEN' });
});

test('legacy active records without a persisted instance name fail closed', () => {
  const current = 'session-legacy-current';
  const started = startReplacement(readReplacementRecord(), {
    role: 'reviewer', oldChildId: OLD_REVIEWER, handoffDigest: 'b'.repeat(64), taskRefs: [],
  }, 1);
  let record = transitionReplacement(started.record, started.operationId, 'standby', 2,
    { newChildId: current });
  for (const phase of ['ready', 'transferring', 'activating', 'active']) {
    record = transitionReplacement(record, started.operationId, phase, record.operations.at(-1).phases.length + 2);
  }
  assert.throws(() => resolveLogicalTeamTarget(record, 'reviewer'), { code: 'TEAM_ROLE_ADDRESS_UNAVAILABLE' });
  assert.throws(() => resolveLogicalTeamTarget(record, current), { code: 'TEAM_MEMBER_RETIRED' });
  assert.deepEqual(projectLogicalTeamDescendants(record, [
    { kind: 'child', id: OLD_REVIEWER, name: 'reviewer', path: 'reviewer' },
    { kind: 'child', id: current, name: 'reviewer-r2', path: 'reviewer-r2' },
    { kind: 'child', id: 'session-unmanaged-current', name: 'foreign', path: 'foreign' },
  ]), [{ kind: 'child', id: 'session-unmanaged-current', name: 'foreign', path: 'foreign' }]);
});

test('list_agents projects only stable current roles and rewrites their descendant paths', () => {
  let record = readReplacementRecord();
  const first = begin(record, 'implementer', OLD_IMPLEMENTER, 'implementer-r2');
  record = activate(first.record, first.operationId);
  const second = begin(record, 'implementer', currentRoleOwner(record, 'implementer'), 'implementer-r3');
  record = activate(second.record, second.operationId);
  const reviewer = begin(record, 'reviewer', OLD_REVIEWER, 'reviewer-r2');
  record = reviewer.record;
  const rows = [
    { name: 'lead', status: 'running', description: 'root agent' },
    { name: 'implementer', status: 'inactive', description: 'retired gen 1' },
    { name: 'implementer-r2', status: 'inactive', description: 'retired gen 2' },
    { name: 'implementer-r2/old-child', status: 'inactive' },
    { name: 'implementer-r3', status: 'running', description: 'current gen 3' },
    { name: 'implementer-r3/checker', status: 'inactive' },
    { name: 'reviewer', status: 'inactive', description: 'frozen' },
    { name: 'reviewer-r2', status: 'inactive', description: 'standby' },
    { name: 'foreign', status: 'inactive' },
  ];
  assert.deepEqual(projectLogicalTeamAgents(record, rows), [
    rows[0],
    { name: 'implementer', status: 'running', description: 'current gen 3' },
    { name: 'implementer/checker', status: 'inactive' },
    rows.at(-1),
  ]);
});

test('unmanaged names and lead ACK routing remain native pass-throughs', () => {
  const record = readReplacementRecord();
  assert.equal(resolveLogicalTeamTarget(record, 'lead'), 'lead');
  assert.equal(resolveLogicalTeamTarget(record, 'foreign/deep'), 'foreign/deep');
  assert.deepEqual(projectLogicalTeamAgents(record, [{ name: 'lead', status: 'running' }]),
    [{ name: 'lead', status: 'running' }]);
});

test('native control service view rewrites only resolution and catalog projection', async () => {
  let record = readReplacementRecord();
  const first = begin(record, 'implementer', OLD_IMPLEMENTER, 'implementer-r2');
  record = activate(first.record, first.operationId);
  const current = currentRoleOwner(record, 'implementer');
  const root = { id: 'session-address-root' }, caller = { id: 'session-caller' };
  const calls = [];
  const native = {
    marker: 'native-service',
    rootOf(agent) { assert.equal(this, native); assert.equal(agent, caller); return root; },
    async resolveName(agent, name, signal) {
      assert.equal(this, native); calls.push(['resolveName', agent, name, signal]); return `resolved:${name}`;
    },
    async listDescendants(rootId, signal) {
      assert.equal(this, native); calls.push(['listDescendants', rootId, signal]);
      return [
        { kind: 'child', id: OLD_IMPLEMENTER, name: 'implementer', path: 'implementer' },
        { kind: 'child', id: current, name: 'implementer-r2', path: 'implementer-r2' },
        { kind: 'child', id: 'session-child-checker', name: 'checker', path: 'implementer-r2/checker' },
      ];
    },
    namesOf(agent) { assert.equal(this, native); assert.equal(agent, caller); return { self: 'implementer-r2', parent: 'lead' }; },
    sendMessage(...args) { assert.equal(this, native); calls.push(['sendMessage', ...args]); return 'message-1'; },
    interrupt(...args) { assert.equal(this, native); calls.push(['interrupt', ...args]); return true; },
  };
  Object.defineProperty(native, CORDIS_TRACKER,
    { value: Object.freeze({ associate: 'subagents', property: 'ctx' }) });
  // Cordis returns a new traceable proxy at each service use site.  That view
  // is still the same Host service and must not trip the drift guard.
  let currentService = traceableService(native);
  const logical = createLogicalSubagents(native, {
    fixedRootId: root.id,
    readRecord(id) { assert.equal(id, root.id); return record; },
    assertCurrent: () => currentService,
  });
  const signal = new AbortController().signal;
  assert.equal(logical[CORDIS_TRACKER], undefined);
  assert.equal(logical[CORDIS_ORIGINAL], undefined);
  assert.equal(await logical.resolveName(caller, 'implementer', signal), `resolved:${current}`);
  assert.equal(await logical.resolveName(caller, 'lead', signal), 'resolved:lead');
  assert.deepEqual(await logical.listDescendants(root.id, signal), [
    { kind: 'child', id: current, name: 'implementer', path: 'implementer' },
    { kind: 'child', id: 'session-child-checker', name: 'checker', path: 'implementer/checker' },
  ]);
  assert.deepEqual(logical.namesOf(caller), { self: 'implementer', parent: 'lead' });
  assert.equal(logical.sendMessage(caller, current, [], { signal }), 'message-1');
  assert.equal(logical.interrupt(current, { kind: 'ancestor', agent: caller }), true);
  assert.equal(logical.marker, 'native-service');
  assert.ok(calls.some(call => call[0] === 'sendMessage'));
  assert.ok(calls.some(call => call[0] === 'interrupt'));
  currentService = {};
  await assert.rejects(logical.resolveName(caller, 'implementer', signal), { code: 'TEAM_ADDRESS_HOST_CHANGED' });
});

test('native task service view keeps board identity and projects owner names only', async () => {
  let record = readReplacementRecord();
  const first = begin(record, 'implementer', OLD_IMPLEMENTER, 'implementer-r2');
  record = activate(first.record, first.operationId);
  const current = currentRoleOwner(record, 'implementer');
  const root = { id: 'session-address-root' }, caller = { id: 'session-caller' };
  const nativeSubagents = { rootOf(agent) { assert.equal(agent, caller); return root; } };
  const calls = [];
  const task = { id: 'task-1', revision: 3, ownerId: current, ownerName: 'implementer-r2' };
  const nativeTeams = {
    isEnabled(agent) { assert.equal(this, nativeTeams); calls.push(['isEnabled', agent]); return true; },
    async createTask(agent, input, signal) {
      assert.equal(this, nativeTeams); calls.push(['createTask', agent, input, signal]); return task;
    },
    getTask(agent, id) { assert.equal(this, nativeTeams); calls.push(['getTask', agent, id]); return task; },
    listTasks(agent) { assert.equal(this, nativeTeams); calls.push(['listTasks', agent]); return [task]; },
    async updateTask(agent, request, signal) {
      assert.equal(this, nativeTeams); calls.push(['updateTask', agent, request, signal]);
      return { ...task, revision: task.revision + 1 };
    },
  };
  Object.defineProperty(nativeTeams, CORDIS_TRACKER,
    { value: Object.freeze({ associate: 'agentTeams', property: 'ctx' }) });
  let currentTeams = traceableService(nativeTeams);
  const logical = createLogicalAgentTeams(nativeTeams, nativeSubagents, {
    fixedRootId: root.id,
    readRecord(id) { assert.equal(id, root.id); return record; },
    assertCurrent: () => currentTeams,
  });
  assert.equal(logical[CORDIS_TRACKER], undefined);
  assert.equal(logical[CORDIS_ORIGINAL], undefined);
  assert.equal(logical.isEnabled(caller), true);
  assert.deepEqual(logical.getTask(caller, 'task-1'), { ...task, ownerName: 'implementer' });
  assert.deepEqual(logical.listTasks(caller), [{ ...task, ownerName: 'implementer' }]);
  const signal = new AbortController().signal;
  assert.deepEqual(await logical.updateTask(caller, { taskId: 'task-1', action: 'edit' }, signal),
    { ...task, revision: 4, ownerName: 'implementer' });
  assert.deepEqual(calls.map(call => call[0]), ['isEnabled', 'getTask', 'listTasks', 'updateTask']);
  currentTeams = {};
  assert.throws(() => logical.listTasks(caller), { code: 'TEAM_ADDRESS_HOST_CHANGED' });
});

test('standby self identity and lead target remain native while its stable business role is unavailable', () => {
  let record = readReplacementRecord();
  const started = begin(record, 'implementer', OLD_IMPLEMENTER, 'implementer-r2');
  record = move(started.record, started.operationId, 'standby');
  assert.equal(projectLogicalTeamName(record, 'implementer-r2'), 'implementer-r2');
  assert.equal(resolveLogicalTeamTarget(record, 'lead'), 'lead');
  assert.throws(() => resolveLogicalTeamTarget(record, 'implementer'), { code: 'TEAM_ROLE_ADDRESS_UNAVAILABLE' });
  assert.deepEqual(projectLogicalTeamDescendants(record, [
    { kind: 'child', id: OLD_IMPLEMENTER, name: 'implementer', path: 'implementer' },
    { kind: 'child', id: record.operations.at(-1).newChildId, name: 'implementer-r2', path: 'implementer-r2' },
    { kind: 'child', id: 'session-foreign-member', name: 'foreign', path: 'foreign' },
  ]), [{ kind: 'child', id: 'session-foreign-member', name: 'foreign', path: 'foreign' }]);
});

test('replacement-managed Presets select logical native control while legacy Presets remain unchanged', async () => {
  const definitions = [];
  const ctx = { agentPresets: { async register(definition) { definitions.push(definition); return () => {}; } } };
  const member = { name: 'implementer', agentPreset: 'dsh-current-address-implementer',
    personaPrompt: 'Implement the task.', nativeToolAllowlist: ['team_task_get', 'send_message'] };
  await registerLauncherPresets(ctx, {
    ownedSessionId: 'session-address-root', replacementOwner: REPLACEMENT_OWNER,
  }, { members: [member] }, CONTROL);
  assert.deepEqual(definitions[0].plugins[0], {
    id: 'dsh-current-address-implementer-native-control',
    name: 'dsh-subagent-live-rc2-local/role-control',
    config: { ownedSessionId: 'session-address-root', replacementOwner: REPLACEMENT_OWNER },
  });
  definitions.length = 0;
  await registerLauncherPresets(ctx, { ownedSessionId: 'session-address-root' }, { members: [member] }, CONTROL);
  assert.deepEqual(definitions[0].plugins[0], {
    id: 'dsh-current-address-implementer-native-control', name: CONTROL.name, config: { interrupt: false },
  });
});
