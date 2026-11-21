import test from 'node:test';
import assert from 'node:assert/strict';
import * as orchestrator from '../src/launcher-replace.js';
import { readReplacementRecord, startReplacement, eligibilityOf, replacementCandidateOf,
  transitionReplacement, verifyReadinessAck, recordOwnerWriteAttempt } from '../src/member-replacement.js';

const ROOT = 'session-10000000-0000-4000-8000-000000000001';
const OLD = 'session-10000000-0000-4000-8000-000000000002';
function fixture(settled = true) {
  const started = startReplacement(readReplacementRecord(undefined), { role: 'implementer', oldChildId: OLD,
    handoffDigest: 'a'.repeat(64), taskRefs: [{ taskId: 'task-1', revision: 1 }], instanceName: 'implementer-r1', candidateConfig: JSON.stringify({
      role: 'implementer', provider: 'fixture', model: 'local', personaPrompt: 'Implement.', prompt: 'Continue.' }) });
  let record = started.record, revision = 1, cancels = 0;
  const host = { signal: new AbortController().signal, ownedSessionId: () => ROOT,
    readRecord: () => ({ value: record, revision }),
    async writeRecord(_id, value, expected) { assert.equal(expected, revision); record = value; revision++; return true; },
    async cancelCandidate({ operation }) {
      cancels++;
      assert.equal(record.operations[0].phase, 'cancelling');
      assert.equal(operation.id, started.operationId);
      return { settled };
    } };
  return { host, started, current: () => record, cancels: () => cancels, seed(value) { record = value; } };
}

test('an explicit cancellation releases a frozen operation whose planned candidate never existed', async () => {
  const h = fixture();
  const result = await orchestrator.cancelReplacement(h.host, h.started.operationId);
  assert.equal(result.ok, true); assert.equal(result.phase, 'aborted');
  assert.equal(eligibilityOf(h.current(), OLD).kind, 'full'); assert.equal(h.cancels(), 1);
  assert.equal((await orchestrator.cancelReplacement(h.host, h.started.operationId)).ok, true);
  assert.equal(h.cancels(), 1, 'repeat cancellation never creates another action');
});

test('unconfirmed cancellation keeps the old member frozen for explicit reconciliation', async () => {
  const h = fixture(false);
  const result = await orchestrator.cancelReplacement(h.host, h.started.operationId);
  assert.equal(result.ok, false); assert.equal(result.phase, 'cancelling');
  assert.equal(eligibilityOf(h.current(), OLD).kind, 'none');
});

test('an owner write intent permanently forbids the cancellation path', async () => {
  const h = fixture(), id = h.started.operationId, childId = replacementCandidateOf(h.current().operations[0]).childId;
  let record = transitionReplacement(h.current(), id, 'standby', Date.now(), { newChildId: childId });
  const op = record.operations[0];
  const ack = verifyReadinessAck({ text: JSON.stringify({ ready: true, operation: id,
    handoff: op.handoffDigest, config: op.configDigest }), senderSessionId: childId, operation: op });
  record = transitionReplacement(record, id, 'ready', Date.now(), { readinessAck: ack.evidence });
  record = transitionReplacement(record, id, 'transferring');
  record = recordOwnerWriteAttempt(record, id, 'task-1', 1);
  h.seed(record);
  await assert.rejects(orchestrator.cancelReplacement(h.host, id), /REPLACEMENT_CANNOT_CANCEL_AFTER_TRANSFER/);
  assert.deepEqual(h.current(), record); assert.equal(h.cancels(), 0);
  assert.equal(eligibilityOf(h.current(), OLD).kind, 'none');
});
