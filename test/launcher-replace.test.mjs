import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceMember, reconcileReplacement } from '../src/launcher-replace.js';
import { buildHandoffSnapshot, readReplacementRecord, startReplacement, eligibilityOf,
  currentRoleOwner, replacementCandidateOf } from '../src/member-replacement.js';

const OWNER = 'session-20000000-0000-4000-8000-000000000002';
const OLD = 'session-8ad8c6c8-3fb8-4f93-800a-9a8b3870abaf';
const OTHER = 'session-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

const request = overrides => ({ role: 'implementer', provider: 'deepseek-account', model: 'deepseek-flash',
  reasoningEffort: 'low', personaPrompt: 'You are the next implementer.', prompt: 'Continue the accepted task.',
  tools: ['team_task_get', 'team_task_update', 'send_message'],
  progressFacts: 'Changed src/a.js; unit tests green; continue task-1.', ...overrides });
const task = (id, ownerId = OLD, overrides = {}) => ({ id, revision: 3, status: 'in_progress',
  subject: `implement ${id}`, description: `progress for ${id}`, ownerId,
  blockedBy: ['task-0'], writeScopes: ['src/a.js'], progress: { completed: 2, total: 3 }, ...overrides });

function hostFixture(overrides = {}) {
  let revision = 7, currentRole = OLD;
  const store = new Map(), spawned = new Map(), planned = new Map(), acks = new Map();
  const controls = { failTask: null, ackSender: null, wrongProof: false };
  const calls = { maintenance: [], observe: [], reassign: [], spawns: [], restores: [], cancels: [],
    activates: [], takeovers: [], candidateClean: 0, persistedAtSpawn: [] };
  const tasks = new Map([
    ['task-1', task('task-1')],
    ['task-2', task('task-2', null, { revision: 1, status: 'pending', subject: 'unowned review',
      blockedBy: [], writeScopes: [] })],
  ]);
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const strictAck = (operation, childId) => {
    acks.set(childId, { senderSessionId: controls.ackSender ?? childId,
      text: JSON.stringify({ ready: true, operation: operation.id,
        handoff: operation.handoffDigest, config: operation.configDigest }) });
  };
  const base = {
    signal: new AbortController().signal,
    now: () => 1e12 + revision,
    ownedSessionId: () => OWNER,
    async preflight() {},
    async observeMember(role, expectedChildId) {
      calls.observe.push({ role, expectedChildId });
      if (expectedChildId !== undefined && expectedChildId !== currentRole) return { available: false };
      return { available: true, quiet: true, childId: currentRole, role };
    },
    async listTasks() { return [...tasks.values()].map(clone); },
    async getTask(id) { return clone(tasks.get(id)); },
    async reassignTask({ taskId, expectedRevision, owner }) {
      calls.reassign.push({ taskId, expectedRevision, owner });
      if (controls.failTask === taskId) return false;
      const current = tasks.get(taskId);
      if (!current || current.revision !== expectedRevision || current.status === 'completed'
        || current.status === 'deleted') return false;
      current.ownerId = owner; current.ownerName = 'replacement'; current.revision += 1; current.status = 'in_progress';
      return true;
    },
    readRecord: rootId => store.get(rootId),
    async writeRecord(rootId, value, expected) {
      if (expected !== undefined && expected !== revision) return false;
      revision += 1;
      store.set(rootId, { revision, value: clone(value) });
      return true;
    },
    async runMaintenanceExclusive(childId, body) {
      calls.maintenance.push(childId);
      return body();
    },
    async assertMemberStillQuiet() {},
    async uniqueInstanceName(role) { return `${role}-r${spawned.size + planned.size + 1}`; },
    async spawnCandidate({ request: candidateRequest, operation }) {
      const durable = readReplacementRecord(store.get(OWNER)?.value);
      const persisted = durable.operations.find(entry => entry.id === operation.id);
      calls.persistedAtSpawn.push(clone(persisted));
      assert.equal(persisted.phase, 'frozen');
      assert.equal(persisted.instanceName, operation.instanceName);
      assert.equal(persisted.presetId, operation.presetId);
      assert.equal(candidateRequest.prompt, request().prompt);
      const plan = replacementCandidateOf(operation), childId = plan.childId;
      assert.equal(plan.agentPreset, operation.presetId);
      spawned.set(operation.id, childId); planned.set(operation.presetId, childId);
      calls.spawns.push({ operationId: operation.id, childId });
      strictAck(operation, childId);
      return { childId };
    },
    async restoreCandidate({ operation }) {
      calls.restores.push(operation.id);
      const childId = operation.newChildId ?? spawned.get(operation.id) ?? planned.get(operation.presetId);
      if (!childId) return { found: false };
      strictAck(operation, childId);
      return { found: true, childId };
    },
    async awaitReadiness(childId) { return clone(acks.get(childId)); },
    async assertCandidateClean() { calls.candidateClean += 1; },
    async cancelCandidate({ operation, childId }) {
      const durable = readReplacementRecord(store.get(OWNER)?.value);
      const cancelling = durable.operations.find(entry => entry.id === operation.id);
      assert.equal(cancelling.phase, 'cancelling');
      if (childId) assert.equal(eligibilityOf(durable, childId).kind, 'none');
      calls.cancels.push({ operationId: operation.id, childId });
      return { settled: true };
    },
    async activateCandidate({ operation, request: candidateRequest }) {
      calls.activates.push({ operationId: operation.id, childId: operation.newChildId,
        prompt: candidateRequest.prompt });
      currentRole = operation.newChildId;
      return { childId: operation.newChildId };
    },
    async observeTakeover({ operation, transferred }) {
      calls.takeovers.push({ operationId: operation.id, transferred: clone(transferred) });
      const entry = transferred.find(item => item.kind === 'transferred');
      if (!entry) throw new Error('fixture expected no takeover observation');
      const current = tasks.get(entry.taskId);
      assert.equal(current.revision, entry.revision);
      current.revision += 1;
      return { success: true, childId: controls.wrongProof ? OLD : operation.newChildId,
        operationId: operation.id, handoffDigest: operation.handoffDigest,
        taskId: entry.taskId, expectedRevision: entry.revision, revision: current.revision,
        callId: `call-${entry.taskId}`, callSeq: 10, resultSeq: 11, action: 'edit' };
    },
    __store: store, __tasks: tasks, __calls: calls, __acks: acks, __planned: planned,
    __controls: controls, __setCurrentRole(id) { currentRole = id; },
  };
  return { ...base, ...overrides, __base: base };
}

async function seedFrozen(host, { childId, tasks = [host.__tasks.get('task-1')] } = {}) {
  const snapshot = buildHandoffSnapshot({ role: 'implementer', tasks: tasks.map(value => structuredClone(value)),
    progress: request().progressFacts });
  const started = startReplacement(readReplacementRecord(undefined), { role: 'implementer', oldChildId: OLD,
    ...snapshot, instanceName: 'implementer-r1', candidateConfig: JSON.stringify(request()) }, host.now());
  await host.__base.writeRecord(OWNER, started.record);
  const plannedChild = childId === undefined
    ? replacementCandidateOf(started.record.operations[0]).childId : childId;
  if (plannedChild) host.__planned.set(started.record.operations[0].presetId, plannedChild);
  return started;
}

test('happy path persists the plan before spawn and returns only after real takeover proof', async () => {
  const host = hostFixture();
  const result = await replaceMember(host, request());
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'active');
  assert.equal(result.newChildId, replacementCandidateOf(host.__calls.persistedAtSpawn[0]).childId);
  assert.equal(result.takeoverProof.kind, 'task-write');
  assert.deepEqual(host.__calls.maintenance, [OLD]);
  assert.equal(host.__calls.spawns.length, 1);
  assert.equal(host.__calls.activates.length, 1);
  assert.equal(host.__calls.takeovers.length, 1);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  const operation = stored.operations[0];
  assert.equal(operation.phase, 'active');
  assert.equal(operation.ownerWriteAttempts.length, 1);
  assert.deepEqual(operation.taskOutcomes.map(item => item.kind), ['transferred']);
  assert.equal(operation.takeoverProof.revision, 5);
  assert.equal(eligibilityOf(stored, OLD).kind, 'none');
  assert.equal(eligibilityOf(stored, result.newChildId).kind, 'full');
  assert.deepEqual(host.__tasks.get('task-1').blockedBy, ['task-0']);
  assert.deepEqual(host.__tasks.get('task-1').progress, { completed: 2, total: 3 });
});

test('preflight and all observation/quiet assertions are awaited before freeze', async () => {
  const observe = Promise.withResolvers(), quiet = Promise.withResolvers();
  let listed = 0;
  const host = hostFixture({
    observeMember: () => observe.promise,
    async listTasks() { listed += 1; return host.__base.listTasks(); },
    assertMemberStillQuiet: () => quiet.promise,
  });
  const pending = replaceMember(host, request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listed, 0); assert.equal(host.__store.size, 0);
  observe.resolve({ available: true, quiet: true, childId: OLD });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listed, 1); assert.equal(host.__store.size, 0);
  quiet.resolve();
  assert.equal((await pending).ok, true);
});

test('a cold-member race is rechecked after the frozen CAS and remains durably fenced', async () => {
  let postFreezeChecks = 0;
  const host = hostFixture({ async assertMemberStillQuiet(role, childId, evidence) {
    assert.equal(role, 'implementer'); assert.equal(childId, OLD);
    if (evidence?.phase !== 'post-freeze') return;
    postFreezeChecks += 1;
    const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
    assert.equal(stored.operations[0].phase, 'frozen');
    assert.equal(evidence.handoffDigest, stored.operations[0].handoffDigest);
    assert.deepEqual(evidence.taskRefs, stored.operations[0].taskRefs);
    throw new Error('OLD_MEMBER_RACED_FREEZE');
  } });
  await assert.rejects(() => replaceMember(host, request()), /OLD_MEMBER_RACED_FREEZE/);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(postFreezeChecks, 1);
  assert.equal(stored.operations[0].phase, 'frozen');
  assert.equal(eligibilityOf(stored, OLD).kind, 'none');
  assert.deepEqual(host.__calls.spawns, []);
  assert.deepEqual(host.__calls.reassign, []);
});

test('instance binding and takeover-write capability fail before the frozen CAS', async () => {
  for (const replacement of [
    request({ expectedOldChildId: OTHER }),
    request({ expectedOldChildId: OLD, tools: ['team_task_get', 'send_message'] }),
  ]) {
    const host = hostFixture();
    await assert.rejects(() => replaceMember(host, replacement),
      /REPLACEMENT_(MEMBER_CHANGED|TAKEOVER_TOOL_REQUIRED)/);
    assert.equal(host.__store.size, 0);
    assert.deepEqual(host.__calls.maintenance, []);
    assert.deepEqual(host.__calls.spawns, []);
  }
});

test('strict ACK uses the native sender and cancellation revokes candidate before thawing old', async () => {
  const host = hostFixture();
  host.__controls.ackSender = OTHER;
  const result = await replaceMember(host, request());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEAM_ACK_WRONG_SENDER');
  assert.equal(result.phase, 'aborted');
  assert.equal(host.__calls.cancels.length, 1);
  assert.deepEqual(host.__calls.reassign, []);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.deepEqual(stored.operations[0].phases.map(item => item.phase),
    ['frozen', 'standby', 'cancelling', 'aborted']);
  assert.equal(eligibilityOf(stored, OLD).kind, 'full');
});

test('unconfirmed candidate cancellation stays cancelling and never revives the old member', async () => {
  const host = hostFixture({ cancelCandidate: async ({ operation, childId }) => {
    host.__base.__calls.cancels.push({ operationId: operation.id, childId });
    return { settled: false };
  } });
  host.__controls.ackSender = OTHER;
  const result = await replaceMember(host, request());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REPLACEMENT_CANCELLATION_UNCONFIRMED');
  assert.equal(result.phase, 'cancelling');
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(eligibilityOf(stored, OLD).kind, 'none');
  assert.equal(eligibilityOf(stored, stored.operations[0].newChildId).kind, 'none');
});

test('a spawn exception cancels by the persisted plan and only then thaws the old member', async () => {
  const host = hostFixture({ async spawnCandidate({ operation }) {
    host.__planned.set(operation.presetId, replacementCandidateOf(operation).childId);
    throw new Error('SPAWN_RESULT_LOST');
  } });
  await assert.rejects(() => replaceMember(host, request()), /SPAWN_RESULT_LOST/);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.deepEqual(stored.operations[0].phases.map(item => item.phase),
    ['frozen', 'cancelling', 'aborted']);
  assert.equal(host.__calls.cancels.length, 1);
  assert.equal(host.__calls.cancels[0].childId, null);
  assert.equal(eligibilityOf(stored, OLD).kind, 'full');
});

test('owner write intent is durable before CAS and an unconfirmed write enters recovery', async () => {
  const host = hostFixture();
  host.__controls.failTask = 'task-1';
  const result = await replaceMember(host, request());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REPLACEMENT_TRANSFER_UNCONFIRMED');
  assert.equal(result.phase, 'recovering');
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(stored.operations[0].ownerWriteAttempts[0].taskId, 'task-1');
  assert.equal(eligibilityOf(stored, OLD).kind, 'none');
  assert.equal(eligibilityOf(stored, stored.operations[0].newChildId).kind, 'standby');
  assert.equal(host.__calls.cancels.length, 0);
});

test('partial multi-task transfer persists progress and explicit reconciliation resumes without respawn', async () => {
  const host = hostFixture();
  host.__tasks.set('task-3', task('task-3', OLD, { revision: 2, blockedBy: ['task-1'] }));
  host.__controls.failTask = 'task-3';
  const first = await replaceMember(host, request());
  assert.equal(first.phase, 'recovering');
  let stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.deepEqual(stored.operations[0].taskOutcomes.map(item => item.taskId), ['task-1']);
  host.__controls.failTask = null;
  const recovered = await reconcileReplacement(host, first.operationId);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.phase, 'active');
  assert.equal(host.__calls.spawns.length, 1);
  assert.ok(host.__calls.restores.length >= 1);
  stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.deepEqual(stored.operations[0].taskOutcomes.map(item => item.taskId).sort(), ['task-1', 'task-3']);
  assert.equal(host.__tasks.get('task-3').ownerId, recovered.newChildId);
  assert.deepEqual(host.__tasks.get('task-3').blockedBy, ['task-1']);
});

test('an exception after a partial owner transfer durably recovers and never runs pre-CAS cancellation', async () => {
  const host = hostFixture();
  host.__tasks.set('task-3', task('task-3', OLD, { revision: 2 }));
  host.getTask = async id => {
    if (id === 'task-3' && host.__tasks.get('task-1').ownerId !== OLD) throw new Error('TASK_READ_UNAVAILABLE');
    return host.__base.getTask(id);
  };
  await assert.rejects(() => replaceMember(host, request()), /TASK_READ_UNAVAILABLE/);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(stored.operations[0].phase, 'recovering');
  assert.equal(stored.operations[0].taskOutcomes[0].taskId, 'task-1');
  assert.equal(host.__calls.cancels.length, 0);
  assert.equal(eligibilityOf(stored, OLD).kind, 'none');
});

test('a lost settings readback after owner CAS keeps the last attempted fence and never thaws old', async () => {
  const host = hostFixture();
  host.readRecord = rootId => {
    if (host.__tasks.get('task-1').ownerId !== OLD) throw new Error('SETTINGS_READ_UNAVAILABLE');
    return host.__base.readRecord(rootId);
  };
  await assert.rejects(() => replaceMember(host, request()), /SETTINGS_READ_UNAVAILABLE/);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(stored.operations[0].phase, 'transferring');
  assert.equal(stored.operations[0].ownerWriteAttempts.length, 1);
  assert.equal(host.__calls.cancels.length, 0);
  assert.equal(eligibilityOf(stored, OLD).kind, 'none');
});

test('a thrown owner write with exact authoritative readback is resolved without guessing failure', async () => {
  const host = hostFixture({ async reassignTask(input) {
    await host.__base.reassignTask(input);
    throw new Error('OWNER_WRITE_RESPONSE_LOST');
  } });
  const result = await replaceMember(host, request());
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'active');
  assert.equal(host.__tasks.get('task-1').ownerId, result.newChildId);
});

test('completed, deleted and disappeared tasks are recorded but never reassigned or used as proof', async () => {
  const host = hostFixture({ async assertCandidateClean() {
    host.__base.__calls.candidateClean += 1;
    host.__tasks.delete('task-missing');
  } });
  host.__tasks.set('task-1', task('task-1', OLD, { status: 'completed', revision: 8 }));
  host.__tasks.set('task-deleted', task('task-deleted', OLD, { status: 'deleted', revision: 5 }));
  host.__tasks.set('task-missing', task('task-missing', OLD, { revision: 2 }));
  const result = await replaceMember(host, request());
  assert.equal(result.ok, true);
  assert.equal(result.takeoverProof.kind, 'not-required');
  assert.equal(host.__calls.reassign.length, 0);
  assert.equal(host.__calls.takeovers.length, 0);
  assert.equal(host.__calls.activates.length, 1);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.deepEqual(stored.operations[0].taskOutcomes.map(item => item.kind).sort(),
    ['completed', 'deleted', 'missing']);
});

test('a frozen operation restores only the planned candidate and never blindly spawns', async () => {
  const host = hostFixture();
  const started = await seedFrozen(host);
  const result = await reconcileReplacement(host, started.operationId);
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'active');
  assert.equal(host.__calls.spawns.length, 0);
  assert.ok(host.__calls.restores.includes(started.operationId));

  const absent = hostFixture();
  const missing = await seedFrozen(absent, { childId: null });
  const unresolved = await reconcileReplacement(absent, missing.operationId);
  assert.deepEqual({ ok: unresolved.ok, code: unresolved.code, phase: unresolved.phase },
    { ok: false, code: 'REPLACEMENT_CANDIDATE_NOT_FOUND', phase: 'frozen' });
  assert.equal(absent.__calls.spawns.length, 0);
});

test('wrong takeover evidence enters recovering instead of reporting active', async () => {
  const host = hostFixture();
  host.__controls.wrongProof = true;
  const result = await replaceMember(host, request());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REPLACEMENT_PROOF_INVALID');
  assert.equal(result.phase, 'recovering');
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(stored.operations[0].takeoverProof, null);
  assert.equal(eligibilityOf(stored, OLD).kind, 'none');
});

test('durable role mapping drives a second replacement after reload', async () => {
  const host = hostFixture();
  const first = await replaceMember(host, request());
  const second = await replaceMember(host, request({ expectedOldChildId: first.newChildId,
    progressFacts: 'Continue the same task after generation one.' }));
  assert.notEqual(second.newChildId, first.newChildId);
  assert.equal(host.__calls.observe.at(-1).expectedChildId, first.newChildId);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(stored.operations.length, 2);
  assert.equal(currentRoleOwner(stored, 'implementer'), second.newChildId);
  assert.equal(eligibilityOf(stored, first.newChildId).kind, 'none');
});

test('cached transfer owner is rechecked before recovery activates business work', async () => {
  const host = hostFixture();
  host.__tasks.set('task-3', task('task-3', OLD, { revision: 2 }));
  host.__controls.failTask = 'task-3';
  const first = await replaceMember(host, request());
  assert.equal(first.phase, 'recovering');
  host.__controls.failTask = null;
  const changed = host.__tasks.get('task-1'); changed.ownerId = OTHER; changed.revision += 1;
  const recovered = await reconcileReplacement(host, first.operationId);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.code, 'REPLACEMENT_SNAPSHOT_STALE');
  assert.equal(recovered.phase, 'recovering');
  assert.equal(host.__calls.activates.length, 0);
});

test('cached transferred tasks that became terminal are refreshed before takeover requirements', async () => {
  const host = hostFixture();
  host.__tasks.set('task-3', task('task-3', OLD, { revision: 2 }));
  host.__controls.failTask = 'task-3';
  const first = await replaceMember(host, request());
  assert.equal(first.phase, 'recovering');
  host.__controls.failTask = null;
  for (const id of ['task-1', 'task-3']) {
    const current = host.__tasks.get(id); current.status = 'completed'; current.revision += 1;
  }
  host.__tasks.get('task-1').ownerId = OTHER;
  const recovered = await reconcileReplacement(host, first.operationId);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.takeoverProof.kind, 'not-required');
  assert.equal(host.__calls.takeovers.length, 0);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.deepEqual(stored.operations[0].taskOutcomes.map(entry => entry.kind), ['completed', 'completed']);
});

test('a later candidate CAS after a Lead edit keeps the transfer baseline and proves takeover', async () => {
  let expectedBaseline;
  const host = hostFixture({ async observeTakeover({ operation, transferred }) {
    const entry = transferred.find(item => item.taskId === 'task-1');
    expectedBaseline = entry.revision;
    const current = host.__tasks.get(entry.taskId);
    assert.equal(current.ownerId, operation.newChildId);
    assert.equal(current.revision, entry.revision + 1);
    const expectedRevision = current.revision;
    current.revision += 1;
    return { success: true, childId: operation.newChildId, operationId: operation.id,
      handoffDigest: operation.handoffDigest, taskId: entry.taskId, expectedRevision,
      revision: current.revision, callId: 'call-existing-progress', callSeq: 20, resultSeq: 21, action: 'edit' };
  } });
  host.__tasks.set('task-3', task('task-3', OLD, { revision: 2 }));
  host.__controls.failTask = 'task-3';
  const first = await replaceMember(host, request());
  assert.equal(first.phase, 'recovering');
  const transferred = host.__tasks.get('task-1');
  transferred.description = 'Legitimate candidate progress after the owner CAS.';
  transferred.revision += 1;
  host.__controls.failTask = null;
  host.__tasks.get('task-3').status = 'completed'; host.__tasks.get('task-3').revision += 1;
  const recovered = await reconcileReplacement(host, first.operationId);
  assert.equal(recovered.ok, true);
  assert.equal(expectedBaseline, 4);
  assert.equal(recovered.takeoverProof.expectedRevision, 5);
  const stored = readReplacementRecord(host.__store.get(OWNER)?.value);
  assert.equal(stored.operations[0].taskOutcomes.find(entry => entry.taskId === 'task-1').revision, 4);
});

test('preflight refusal and record CAS conflict remain zero-side-effect failures', async () => {
  const unauthorized = hostFixture({ preflight: async () => { throw new Error('REPLACEMENT_ROUTE_UNAUTHORIZED'); } });
  await assert.rejects(() => replaceMember(unauthorized, request()), /REPLACEMENT_ROUTE_UNAUTHORIZED/);
  assert.equal(unauthorized.__store.size, 0);
  assert.equal(unauthorized.__calls.spawns.length, 0);

  let failFirst = true;
  const conflict = hostFixture({ async writeRecord(rootId, value, expected) {
    if (failFirst) { failFirst = false; return false; }
    return conflict.__base.writeRecord(rootId, value, expected);
  } });
  await assert.rejects(() => replaceMember(conflict, request()), /REPLACEMENT_PERSISTENCE_CONFLICT/);
  assert.equal(conflict.__calls.spawns.length, 0);
});
