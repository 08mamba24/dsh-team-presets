import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogicalSubagents, projectLogicalTeamAgents } from '../src/team-addressing.js';
import { readReplacementRecord } from '../src/member-replacement.js';
import { makeLauncherSpawnCall } from '../src/launcher-native.js';

test('alpha.2 native list envelope keeps actual shared capacity while projecting its agents', () => {
  const record = readReplacementRecord();
  const agents = [{ name: 'lead', status: 'running' }, { name: 'reviewer', status: 'inactive' }];
  // A setting may be reduced below the number of already occupied slots.
  const envelope = { running: 7, limit: 3, agents };
  const result = projectLogicalTeamAgents(record, envelope);
  assert.deepEqual(result, envelope);
  assert.notEqual(result, envelope);
  assert.equal(result.running, 7); assert.equal(result.limit, 3);
  assert.deepEqual(projectLogicalTeamAgents(record, agents), agents);
  assert.equal(envelope.agents, agents);
});

test('native list envelopes never guess capacity or accept unknown shapes', () => {
  for (const value of [{ agents: [] }, { running: 0, agents: [] }, { limit: 8, agents: [] },
    { running: -1, limit: 8, agents: [] }, { running: 0, limit: 0, agents: [] },
    { running: 0.5, limit: 8, agents: [] }, { running: 0, limit: 8, agents: null },
    { running: 0, limit: 8, agents: [], guessed: true }]) {
    assert.throws(() => projectLogicalTeamAgents(readReplacementRecord(), value),
      { code: 'TEAM_ADDRESS_NATIVE_RESULT_INVALID' });
  }
});

test('an unknown native service method stays bound to the exact original capacity authority', () => {
  const caller = {}, capacity = { running: 5, limit: 8 };
  const native = { rootOf: () => ({ id: 'session-root-probe' }), resolveName() {},
    listDescendants() {}, namesOf() {}, capacityOf(actual) {
      assert.equal(this, native); assert.equal(actual, caller); return capacity;
    } };
  const facade = createLogicalSubagents(native, { readRecord: () => readReplacementRecord() });
  assert.equal(facade.capacityOf(caller), capacity);
});

test('delegation inherits the validated parent workspace without the removed model-side cwd argument', () => {
  const member = { name: 'frontend', description: 'Frontend work', provider: 'p', model: 'm',
    reasoningEffort: 'max', agentPreset: 'dsh-team-frontend' };
  const call = makeLauncherSpawnCall(member, { workspace: process.cwd(), prompt: 'Confirm readiness.' });
  const args = JSON.parse(call.arguments);
  assert.equal(Object.hasOwn(args, 'cwd'), false);
  assert.equal(args.name, 'frontend'); assert.equal(args.agent_preset, member.agentPreset);
  assert.throws(() => makeLauncherSpawnCall(member, { workspace: 'relative', prompt: 'Ready.' }),
    { code: 'LAUNCHER_SPAWN_INPUT_INVALID' });
});
