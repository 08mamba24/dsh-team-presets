import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLogicalTeamTarget, projectLogicalTeamAgents, projectLogicalTeamDescendants } from '../src/team-addressing.js';
import { readReplacementRecord, ensureReplacementBaseBinding, startReplacement, transitionReplacement,
  replacementCandidateOf, withMembership, eligibilityOf, admissionAllowlist } from '../src/member-replacement.js';
import { appendAddition, appendRemoval, settleAddition, rosterOf, parseMembership } from '../src/member-roster.js';

const OLD_FRONTEND = 'session-11111111-1111-4111-8111-111111111111';
const BACKEND = 'session-33333333-3333-4333-8333-333333333333';
const member = name => ({ name, description: `${name} duty`, prompt: `Start ${name}.`, persona_prompt: `You are ${name}.`,
  agent_preset: `dsh-current-abc-${name}`, provider: 'p', model: 'm', reasoning_effort: 'max', native_tool_allowlist: ['team_task_get'] });
const base = () => ensureReplacementBaseBinding(readReplacementRecord(undefined), JSON.stringify({ workspace: '/w',
  template: { template_schema: 'dsh-team-template/1', version: 1, name: 't', members: ['frontend', 'backend'].map(member) } }));

test('addition readiness cannot execute work before active, and failed/removed sessions cannot resume', () => {
  const added = appendAddition([], { name: 'researcher', member: member('researcher') });
  let record = withMembership(base(), added.membership);
  assert.equal(eligibilityOf(record, added.entry.childId).kind, 'starting');
  assert.deepEqual(admissionAllowlist(eligibilityOf(record, added.entry.childId), ['write']), []);
  record = withMembership(record, settleAddition(record.membership, added.entry.id, 'failed'));
  assert.equal(eligibilityOf(record, added.entry.childId).kind, 'none');
  record = withMembership(record, appendRemoval(record.membership, { name: 'backend', childId: BACKEND }).membership);
  assert.equal(eligibilityOf(record, BACKEND).kind, 'none');
});

function replaceFrontend(record) {
  const request = { role: 'frontend', provider: 'p', model: 'm2', reasoningEffort: 'max', personaPrompt: 'x', prompt: 'y',
    tools: ['team_task_get', 'send_message'], progressFacts: 'none' };
  let { record: next, operationId } = startReplacement(record, { role: 'frontend', oldChildId: OLD_FRONTEND, handoffDigest: 'a'.repeat(64),
    taskRefs: [], handoffText: 'handoff', candidateConfig: JSON.stringify(request), instanceName: 'frontend-r1' }, 1);
  next = transitionReplacement(next, operationId, 'standby', 2, { newChildId: replacementCandidateOf(next.operations[0]).childId });
  const op = next.operations[0];
  next = transitionReplacement(next, op.id, 'ready', 3, { readinessAck: { senderSessionId: op.newChildId,
    handoffDigest: op.handoffDigest, configDigest: op.configDigest, at: 3 } });
  next = transitionReplacement(next, op.id, 'transferring', 4);
  next = transitionReplacement(next, op.id, 'activating', 5);
  next = transitionReplacement(next, op.id, 'active', 6, { takeoverProof: { kind: 'not-required', reason: 'no-unfinished-tasks', at: 6 } });
  return { record: next, newChildId: op.newChildId };
}

test('rc.7 records without membership round-trip with their exact shape', () => {
  const record = base();
  assert.deepEqual(Object.keys(record), ['version', 'baseBinding', 'operations']);
  assert.deepEqual(readReplacementRecord(structuredClone(record)), record);
  assert.throws(() => readReplacementRecord({ version: 1, operations: [], membership: [] }), { code: 'REPLACEMENT_RECORD_INVALID' });
});

test('removing an original native member accepts its real bare UUID Session id', () => {
  const childId = '33333333-3333-4333-8333-333333333333';
  const record = withMembership(base(), appendRemoval([], { name: 'backend', childId }).membership);
  assert.equal(eligibilityOf(record, childId).kind, 'none');
  assert.throws(() => resolveLogicalTeamTarget(record, childId), { code: 'TEAM_MEMBER_RETIRED' });
});

test('membership additions and removals persist beside the immutable base binding', () => {
  let record = base();
  const added = appendAddition([], { name: 'researcher', member: member('researcher'), at: 10 });
  record = withMembership(record, added.membership);
  assert.equal(record.membership[0].phase, 'spawning');
  assert.match(record.membership[0].childId, /^session-[0-9a-f-]{36}$/);
  record = withMembership(record, settleAddition(record.membership, added.entry.id, 'active', 11));
  const roster = rosterOf(record, JSON.parse(record.baseBinding).template.members);
  assert.deepEqual(roster.members.map(row => [row.name, row.origin, row.phase]),
    [['frontend', 'template', 'active'], ['backend', 'template', 'active'], ['researcher', 'added', 'active']]);
  const removed = appendRemoval(record.membership, { name: 'backend', childId: BACKEND, at: 12 });
  record = withMembership(record, removed.membership);
  assert.deepEqual(rosterOf(record, JSON.parse(record.baseBinding).template.members).members.map(row => row.name), ['frontend', 'researcher']);
  assert.deepEqual(readReplacementRecord(structuredClone(record)), record);
  // A removed name is never reused and an addition is never duplicated.
  assert.throws(() => parseMembership([...record.membership, appendAddition([], { name: 'backend', member: member('backend') }).entry]),
    { code: 'MEMBER_ENTRY_INVALID' });
  assert.throws(() => parseMembership([...record.membership, appendAddition([], { name: 'researcher', member: member('researcher') }).entry]),
    { code: 'MEMBER_ENTRY_INVALID' });
  assert.throws(() => settleAddition(record.membership, added.entry.id, 'failed'), { code: 'MEMBER_ADDITION_NOT_PENDING' });
});

test('any member name with replacement history addresses its current child; removed members are refused everywhere', () => {
  let { record, newChildId } = replaceFrontend(base());
  assert.equal(resolveLogicalTeamTarget(record, 'frontend'), newChildId);
  assert.equal(resolveLogicalTeamTarget(record, 'backend'), 'backend', 'unmanaged names pass through to native');
  assert.throws(() => resolveLogicalTeamTarget(record, OLD_FRONTEND), { code: 'TEAM_MEMBER_RETIRED' });
  record = withMembership(record, appendRemoval([], { name: 'backend', childId: BACKEND }).membership);
  record = withMembership(record, appendRemoval(record.membership, { name: 'frontend', childId: newChildId }).membership);
  for (const target of ['backend', 'backend/helper', 'frontend']) {
    assert.throws(() => resolveLogicalTeamTarget(record, target), { code: 'TEAM_MEMBER_REMOVED' });
  }
  for (const target of [BACKEND, newChildId, OLD_FRONTEND]) {
    assert.throws(() => resolveLogicalTeamTarget(record, target), { code: 'TEAM_MEMBER_RETIRED' });
  }
  assert.throws(() => resolveLogicalTeamTarget(record, 'frontend-r1'), { code: 'TEAM_PHYSICAL_ADDRESS_FORBIDDEN' });
  assert.deepEqual(projectLogicalTeamAgents(record, [{ name: 'backend' }, { name: 'frontend-r1' }, { name: 'tester' }]), [{ name: 'tester' }]);
  assert.deepEqual(projectLogicalTeamDescendants(record, [{ id: BACKEND, path: 'backend' }, { id: 'session-x1234567', path: 'tester' }]),
    [{ id: 'session-x1234567', path: 'tester' }]);
});
