import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReplacementRequest, readReplacementRecord, startReplacement, transitionReplacement,
  cancelReplacement, eligibilityOf, admissionAllowlist, buildHandoffSnapshot, verifyReadinessAck,
  verifyTakeoverProof, recordOwnerWriteAttempt, recordTaskOutcome, currentRoleOwner,
  replacementRequestOf, replacementCandidateOf, ensureReplacementBaseBinding, STANDBY_TOOLS,
} from '../src/member-replacement.js';

const OLD_CHILD = 'session-8ad8c6c8-3fb8-4f93-800a-9a8b3870abaf';
const request = overrides => ({ role: 'implementer', provider: 'deepseek-account', model: 'deepseek-flash',
  reasoningEffort: 'low', personaPrompt: 'You are the implementer.', prompt: 'Stand by for handoff.',
  tools: ['team_task_get', 'team_task_update', 'send_message', 'read', 'write'],
  progressFacts: 'Changed files: src/a.js. Tests: unit green. Next: continue task-1.', ...overrides });
const snapshot = () => buildHandoffSnapshot({ role: 'implementer', tasks: [{
  id: 'task-1', revision: 3, status: 'in_progress', subject: 'implement 2+3',
  description: 'Keep the real progress and dependencies.', ownerId: OLD_CHILD,
  blockedBy: ['task-0'], writeScopes: ['src/a.js'], progress: { completed: 2, total: 3 },
}], progress: request().progressFacts });

function begin(record = readReplacementRecord(undefined), overrides = {}) {
  const candidateConfig = JSON.stringify(request(overrides.request));
  return startReplacement(record, { role: 'implementer', oldChildId: OLD_CHILD, ...snapshot(),
    instanceName: 'implementer-r1', candidateConfig, ...overrides });
}

function readyState(started, childId = replacementCandidateOf(started.record.operations.at(-1)).childId) {
  const standby = transitionReplacement(started.record, started.operationId, 'standby', 2, { newChildId: childId });
  const operation = standby.operations.at(-1);
  const text = JSON.stringify({ ready: true, operation: operation.id,
    handoff: operation.handoffDigest, config: operation.configDigest });
  const ack = verifyReadinessAck({ text, senderSessionId: childId, operation, at: 3 });
  assert.equal(ack.ok, true);
  return transitionReplacement(standby, operation.id, 'ready', 3, { readinessAck: ack.evidence });
}

function activeState(started, childId = replacementCandidateOf(started.record.operations.at(-1)).childId) {
  const ready = readyState(started, childId);
  const operationId = started.operationId;
  let transferring = transitionReplacement(ready, operationId, 'transferring', 4);
  transferring = recordOwnerWriteAttempt(transferring, operationId, 'task-1', 3, 5);
  transferring = recordTaskOutcome(transferring, operationId,
    { taskId: 'task-1', kind: 'transferred', revision: 4 }, 6);
  const activating = transitionReplacement(transferring, operationId, 'activating', 7);
  const operation = activating.operations.at(-1);
  const proof = verifyTakeoverProof({ proof: { success: true, childId, operationId,
    handoffDigest: operation.handoffDigest, taskId: 'task-1', expectedRevision: 4, revision: 5,
    callId: 'call-task-1', callSeq: 10, resultSeq: 11, action: 'edit' },
  operation, at: 8 });
  assert.equal(proof.ok, true);
  return transitionReplacement(activating, operationId, 'active', 8, { takeoverProof: proof.evidence });
}

test('parses an explicit replacement request and rejects substitutions', () => {
  const parsed = parseReplacementRequest(request());
  assert.equal(parsed.role, 'implementer');
  assert.equal(parsed.reasoningEffort, 'low');
  assert.equal(parseReplacementRequest(request({ reasoningEffort: 'max' })).reasoningEffort, 'max');
  assert.equal(parseReplacementRequest(request({ expectedOldChildId: OLD_CHILD })).expectedOldChildId, OLD_CHILD);
  assert.deepEqual([...parsed.tools], request().tools);
  for (const bad of [
    request({ role: 'lead' }), request({ provider: '' }), request({ model: ' ' }),
    request({ reasoningEffort: '' }), request({ personaPrompt: '' }),
    request({ prompt: 'x'.repeat(8001) }), request({ tools: ['plugin_manager'] }),
    request({ tools: ['read', 'read'] }), request({ expectedOldChildId: 'not-a-session' }),
    { ...request(), extra: 1 },
  ]) assert.throws(() => parseReplacementRequest(bad), /REPLACEMENT_/);
  const defaulted = parseReplacementRequest({ role: 'reviewer', provider: 'p', model: 'm',
    personaPrompt: 'p', prompt: 's' });
  assert.deepEqual([...defaulted.tools], ['team_task_get', 'team_task_update', 'send_message', 'wait_agent']);
  assert.equal(defaulted.reasoningEffort, 'max');
});

test('record persists the candidate plan, full task snapshots and large valid config', () => {
  const large = request({ personaPrompt: 'p'.repeat(16_000), prompt: 'q'.repeat(7_900) });
  const { record } = begin(readReplacementRecord(undefined), { candidateConfig: JSON.stringify(large) });
  const operation = record.operations[0];
  assert.equal(operation.instanceName, 'implementer-r1');
  assert.match(operation.presetId, /^dsh-replace-[0-9a-f-]{36}$/);
  assert.match(operation.configDigest, /^[a-f0-9]{64}$/);
  assert.equal(replacementRequestOf(operation).personaPrompt.length, 16_000);
  assert.deepEqual(operation.taskRefs[0].snapshot.blockedBy, ['task-0']);
  assert.deepEqual(operation.taskRefs[0].snapshot.progress, { completed: 2, total: 3 });
  assert.ok(Object.isFrozen(operation.taskRefs[0].snapshot));
  assert.ok(Object.isFrozen(operation.taskRefs[0].snapshot.blockedBy));
  assert.deepEqual(readReplacementRecord(JSON.parse(JSON.stringify(record))), record);
});

test('root base binding is immutable JSON configuration and survives every operation rewrite', () => {
  const baseBinding = JSON.stringify({ workspace: '/isolated/workspace',
    template: { members: [{ name: 'implementer', persona_prompt: 'p'.repeat(70_000),
      agent_preset: 'dsh-current-root-implementer' }] } });
  let record = ensureReplacementBaseBinding(readReplacementRecord(undefined), baseBinding);
  assert.equal(record.baseBinding, baseBinding);
  const started = begin(record);
  assert.equal(started.record.baseBinding, baseBinding);
  const candidate = replacementCandidateOf(started.record.operations[0]);
  const standby = transitionReplacement(started.record, started.operationId, 'standby', 2,
    { newChildId: candidate.childId });
  assert.equal(standby.baseBinding, baseBinding);
  assert.equal(ensureReplacementBaseBinding(standby, baseBinding), standby);
  assert.throws(() => ensureReplacementBaseBinding(standby,
    JSON.stringify({ workspace: '/other', template: {} })), /REPLACEMENT_BASE_BINDING_MISMATCH/);
  for (const invalid of ['not-json', JSON.stringify({ workspace: '/x' }),
    JSON.stringify({ workspace: '/x', template: {}, state: 'active' })]) {
    assert.throws(() => ensureReplacementBaseBinding(readReplacementRecord(undefined), invalid),
      /REPLACEMENT_BASE_BINDING_INVALID/);
  }
});

test('candidate config durably reserves the exact native preset and child before spawn', () => {
  const { record } = begin();
  const operation = record.operations[0], candidate = replacementCandidateOf(operation);
  assert.equal(candidate.agentPreset, operation.presetId);
  assert.match(candidate.childId, /^session-[0-9a-f-]{36}$/);
  assert.equal(candidate.request.role, operation.role);
  const raw = JSON.parse(operation.candidateConfig);
  assert.equal(raw.agentPreset, operation.presetId);
  assert.equal(raw.childId, candidate.childId);
  assert.equal(raw.prompt, request().prompt);
});

test('record round trip rejects phase, plan and task-evidence tampering', () => {
  const { record } = begin();
  for (const corrupt of [
    { version: 2, operations: [] }, { version: 1 }, { version: 1, operations: {} },
    { version: 1, operations: [{ ...record.operations[0], phase: 'unknown' }] },
    { version: 1, operations: [{ ...record.operations[0], handoffDigest: 'zz' }] },
    { version: 1, operations: [{ ...record.operations[0], oldChildId: 'not-a-session' }] },
    { version: 1, operations: [{ ...record.operations[0], phases: [] }] },
    { version: 1, operations: [{ ...record.operations[0], presetId: 'shared-preset' }] },
    { version: 1, operations: [{ ...record.operations[0], taskRefs: [{ ...record.operations[0].taskRefs[0],
      snapshot: { ...record.operations[0].taskRefs[0].snapshot, id: 'other' } }] }] },
    { version: 1, operations: [{ ...record.operations[0], ownerWriteAttempts: [{ taskId: 'other', expectedRevision: 1, at: 1 }] }] },
    { version: 1, operations: [{ ...record.operations[0], ownerWriteAttempts: null }] },
    { version: 1, operations: [{ ...record.operations[0], taskOutcomes: null }] },
  ]) assert.throws(() => readReplacementRecord(corrupt), /REPLACEMENT_/);
});

test('phase transitions require strict ACK, durable transfer evidence and takeover proof', () => {
  const started = begin();
  assert.throws(() => transitionReplacement(started.record, started.operationId, 'active'), /REPLACEMENT_TRANSITION_INVALID/);
  const candidateId = replacementCandidateOf(started.record.operations[0]).childId;
  const standby = transitionReplacement(started.record, started.operationId, 'standby', 2, { newChildId: candidateId });
  assert.throws(() => transitionReplacement(standby, started.operationId, 'ready', 3), /REPLACEMENT_ACK_INVALID/);
  const ready = readyState(started);
  const transferring = transitionReplacement(ready, started.operationId, 'transferring', 4);
  assert.throws(() => transitionReplacement(transferring, started.operationId, 'activating', 5), /REPLACEMENT_TRANSFER_INCOMPLETE/);
  let attempted = recordOwnerWriteAttempt(transferring, started.operationId, 'task-1', 3, 5);
  attempted = recordTaskOutcome(attempted, started.operationId,
    { taskId: 'task-1', kind: 'transferred', revision: 4 }, 6);
  const activating = transitionReplacement(attempted, started.operationId, 'activating', 7);
  assert.throws(() => transitionReplacement(activating, started.operationId, 'active', 8), /REPLACEMENT_PROOF_INVALID/);
  const active = activeState(started);
  assert.equal(active.operations[0].phase, 'active');
  assert.equal(active.operations[0].takeoverProof.kind, 'task-write');
  assert.throws(() => transitionReplacement(active, started.operationId, 'aborted'), /REPLACEMENT_TRANSITION_INVALID/);
});

test('pre-owner-write cancellation denies both members until candidate settlement is confirmed', () => {
  const started = begin();
  const childId = replacementCandidateOf(started.record.operations[0]).childId;
  const standby = transitionReplacement(started.record, started.operationId, 'standby', 2, { newChildId: childId });
  const cancelling = transitionReplacement(standby, started.operationId, 'cancelling', 3);
  assert.equal(eligibilityOf(cancelling, OLD_CHILD).kind, 'none');
  assert.equal(eligibilityOf(cancelling, childId).kind, 'none');
  const cancelled = cancelReplacement(cancelling, started.operationId, 4);
  assert.equal(eligibilityOf(cancelled, OLD_CHILD).kind, 'full');
  assert.equal(eligibilityOf(cancelled, childId).kind, 'none');
  const transferring = transitionReplacement(readyState(started), started.operationId, 'transferring', 5);
  const attempted = recordOwnerWriteAttempt(transferring, started.operationId, 'task-1', 3, 6);
  assert.throws(() => transitionReplacement(attempted, started.operationId, 'cancelling', 7),
    /REPLACEMENT_TRANSITION_INVALID/);
});

test('eligibility is standby in recovery, full only while activating/active, and none while cancelling', () => {
  const started = begin();
  const childId = replacementCandidateOf(started.record.operations[0]).childId;
  const ready = readyState(started);
  let transferring = transitionReplacement(ready, started.operationId, 'transferring', 4);
  assert.equal(eligibilityOf(transferring, childId).kind, 'standby');
  const recovering = transitionReplacement(transferring, started.operationId, 'recovering', 5);
  assert.equal(eligibilityOf(recovering, childId).kind, 'standby');
  transferring = recordTaskOutcome(transferring, started.operationId,
    { taskId: 'task-1', kind: 'completed', revision: 4 }, 6);
  const activating = transitionReplacement(transferring, started.operationId, 'activating', 7);
  assert.equal(eligibilityOf(activating, childId).kind, 'full');
  assert.equal(eligibilityOf(activating, OLD_CHILD).kind, 'none');
});

test('admission allowlist: standby reads only; full keeps configured plus collaboration floor', () => {
  const configured = ['read', 'write', 'bash'];
  assert.deepEqual([...admissionAllowlist({ kind: 'none' }, configured)], []);
  assert.deepEqual([...admissionAllowlist({ kind: 'standby' }, configured)], [...STANDBY_TOOLS]);
  const full = admissionAllowlist({ kind: 'full' }, configured);
  for (const name of [...configured, 'team_task_get', 'team_task_update', 'send_message', 'wait_agent']) {
    assert.ok(full.includes(name), `full admission keeps ${name}`);
  }
  assert.equal(full.includes('plugin_manager'), false);
});

test('durable role mapping supports a second replacement and rejects a broken chain', () => {
  const first = begin();
  const active = activeState(first);
  const firstChild = replacementCandidateOf(first.record.operations[0]).childId;
  assert.equal(currentRoleOwner(active, 'implementer'), firstChild);
  assert.throws(() => begin(active), /REPLACEMENT_OLD_MEMBER_MISMATCH/);
  const second = startReplacement(active, { role: 'implementer', oldChildId: firstChild, ...snapshot(),
    instanceName: 'implementer-r2', candidateConfig: JSON.stringify(request()) });
  assert.equal(second.record.operations.length, 2);
  assert.equal(currentRoleOwner(second.record, 'implementer'), firstChild);
  const secondChild = replacementCandidateOf(second.record.operations.at(-1)).childId;
  const secondStandby = transitionReplacement(second.record, second.operationId, 'standby', 9, { newChildId: secondChild });
  assert.equal(eligibilityOf(secondStandby, firstChild).kind, 'none');
  assert.equal(eligibilityOf(secondStandby, secondChild).kind, 'standby');
});

test('handoff snapshot binds complete task state and rejects non-JSON progress', () => {
  const snap = snapshot();
  assert.equal(snap.taskRefs.length, 1);
  assert.match(snap.handoffDigest, /^[a-f0-9]{64}$/);
  assert.ok(snap.text.includes('task-1 @3'));
  assert.ok(snap.text.includes('src/a.js'));
  assert.throws(() => buildHandoffSnapshot({ role: 'implementer', tasks: snapshot().tasks, progress: '' }),
    /REPLACEMENT_HANDOFF_INVALID/);
  assert.throws(() => buildHandoffSnapshot({ role: 'lead', tasks: [], progress: 'x' }), /REPLACEMENT_HANDOFF_INVALID/);
  const cyclic = { id: 't', revision: 1, status: 'in_progress', subject: 's' }; cyclic.cycle = cyclic;
  assert.throws(() => buildHandoffSnapshot({ role: 'implementer', tasks: [cyclic], progress: 'x' }),
    /REPLACEMENT_HANDOFF_INVALID/);
});

test('readiness ACK is exact JSON bound to real sender, operation, handoff and config', () => {
  const started = begin();
  const childId = replacementCandidateOf(started.record.operations[0]).childId;
  const standby = transitionReplacement(started.record, started.operationId, 'standby', 2, { newChildId: childId });
  const operation = standby.operations[0];
  const body = { ready: true, operation: operation.id,
    handoff: operation.handoffDigest, config: operation.configDigest };
  assert.equal(verifyReadinessAck({ text: JSON.stringify(body), senderSessionId: childId, operation, at: 3 }).ok, true);
  assert.equal(verifyReadinessAck({ text: `prefix ${JSON.stringify(body)}`, senderSessionId: childId, operation }).reason,
    'TEAM_ACK_INVALID_JSON');
  assert.equal(verifyReadinessAck({ text: JSON.stringify({ ...body, extra: true }), senderSessionId: childId, operation }).reason,
    'TEAM_ACK_INVALID_SHAPE');
  assert.equal(verifyReadinessAck({ text: JSON.stringify(body), senderSessionId: OLD_CHILD, operation }).reason,
    'TEAM_ACK_WRONG_SENDER');
  assert.equal(verifyReadinessAck({ text: JSON.stringify({ ...body, config: 'f'.repeat(64) }),
    senderSessionId: childId, operation }).reason, 'TEAM_ACK_VERSION_MISMATCH');
});

test('takeover proof binds child, operation, handoff, task and post-transfer revision', () => {
  const started = begin();
  const childId = replacementCandidateOf(started.record.operations[0]).childId;
  let transferring = transitionReplacement(readyState(started), started.operationId, 'transferring', 4);
  transferring = recordOwnerWriteAttempt(transferring, started.operationId, 'task-1', 3, 5);
  transferring = recordTaskOutcome(transferring, started.operationId,
    { taskId: 'task-1', kind: 'transferred', revision: 4 }, 6);
  const operation = transitionReplacement(transferring, started.operationId, 'activating', 7).operations[0];
  const valid = { success: true, childId, operationId: operation.id,
    handoffDigest: operation.handoffDigest, taskId: 'task-1', expectedRevision: 4, revision: 5,
    callId: 'call-task-1', callSeq: 10, resultSeq: 11, action: 'edit' };
  assert.equal(verifyTakeoverProof({ proof: valid, operation, at: 8 }).ok, true);
  assert.equal(verifyTakeoverProof({ proof: { ...valid, expectedRevision: 5, revision: 6,
    callId: 'call-after-lead-edit' }, operation, at: 8 }).ok, true);
  for (const invalid of [
    { ...valid, childId: OLD_CHILD }, { ...valid, operationId: 'replace-wrong' },
    { ...valid, handoffDigest: 'f'.repeat(64) }, { ...valid, taskId: 'task-other' },
    { ...valid, expectedRevision: 3, revision: 4 }, { ...valid, revision: 4 }, { ...valid, extra: true },
  ]) assert.equal(verifyTakeoverProof({ proof: invalid, operation, at: 8 }).ok, false);
});
