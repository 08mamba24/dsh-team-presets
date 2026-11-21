import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyLegacyBinding } from '../src/launcher-current.js';
import { validateLauncherTemplate } from '../src/launcher-config.js';
import { launcherTemplateFingerprint } from '../src/launcher-template.js';

const template = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
const members = template.members.map((role, i) => ({ id: `old-${i}`, name: role.name }));
const receipt = { ok: true, mode: 'launch', templateFingerprint: launcherTemplateFingerprint(validateLauncherTemplate(template)),
  members: template.members.map((role, i) => ({ ...members[i], agentPreset: role.agent_preset })) };
const events = [ { type: 'command/run', data: { commandId: 'native-launch', name: 'dsh-team', args: 'launch' } },
  { type: 'command/done', data: { commandId: 'native-launch', kind: 'success', text: JSON.stringify(receipt) } } ];

test('legacy bootstrap authenticates the entire original template and native member identities', () => {
  assert.equal(verifyLegacyBinding(events, members, template), true);
  const changed = structuredClone(template); changed.members[0].persona_prompt += ' Later defaults';
  assert.equal(verifyLegacyBinding(events, members, changed), false);
  assert.equal(verifyLegacyBinding(events, [{ ...members[0], id: 'different-child' }, members[1]], template), false);
  assert.equal(verifyLegacyBinding([{ ...events[1], type: 'assistant/message' }], members, template), false);
  assert.equal(verifyLegacyBinding([events[1]], members, template), false);
});
