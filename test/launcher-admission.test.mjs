import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLauncherPresets } from '../src/launcher-native.js';
import { CONTROL } from './fixtures/control-entry.mjs';

const OWNER = 'session-launcher-admission-owner';
const OPERATION = 'replace-12345678-1234-4234-8234-123456789abc';
const candidate = () => ({
  name: 'implementer',
  agentPreset: 'dsh-team-implementer-r2',
  personaPrompt: 'Read the immutable handoff and acknowledge readiness.',
  nativeToolAllowlist: ['write'],
  standbyOperationId: OPERATION,
});

test('candidate Preset carries immutable standby identity without widening requested active tools', async () => {
  const definitions = [];
  const ctx = { agentPresets: { async register(definition) {
    definitions.push(structuredClone(definition)); return () => {};
  } } };
  await registerLauncherPresets(ctx, { ownedSessionId: OWNER }, { members: [candidate()] }, CONTROL);
  assert.deepEqual(definitions[0].plugins[1], {
    id: 'dsh-team-implementer-r2-persona',
    name: 'dsh-subagent-live-rc2-local/launcher-role',
    config: {
      ownedSessionId: OWNER,
      roleName: 'implementer',
      personaPrompt: 'Read the immutable handoff and acknowledge readiness.',
      tools: ['write'],
      standbyOperationId: OPERATION,
    },
  });
});

test('invalid standby identity is rejected before native Preset registration', async () => {
  let registrations = 0;
  const ctx = { agentPresets: { register() { registrations++; } } };
  await assert.rejects(registerLauncherPresets(ctx, { ownedSessionId: OWNER }, {
    members: [{ ...candidate(), standbyOperationId: 'replace-not-a-uuid' }],
  }, CONTROL), error => error.code === 'LAUNCHER_PRESET_INPUT_INVALID');
  assert.equal(registrations, 0);
});
