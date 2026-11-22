// Multi-member launcher: arbitrary stable member names, per-member Preset, tools and stream bounds.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { launcherHost } from './fixtures/launcher-host.mjs';
import { parseLauncherConfig, validateLauncherTemplate } from '../src/launcher-config.js';
import { authorizeTeam } from '../src/team-config.js';
import { createTeamGate } from '../src/team-gate.js';
const { applyLauncher } = await import('../src/launcher-driver.js');
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' ? 'file-bound fixture' : false }, fn);
const decode = envelope => ({ ...envelope, value: JSON.parse(envelope.text) });

const member = (name, extra = {}) => ({ name, description: `${name} duty`, prompt: `Start ${name}.`,
  persona_prompt: `You are ${name}.`, agent_preset: `dsh-team-${name}`, provider: 'deepseek-account',
  model: 'deepseek-flash', reasoning_effort: 'max', native_tool_allowlist: ['team_task_get'], ...extra });
const template = names => ({ template_schema: 'dsh-team-template/1', version: 1, name: 'five-member',
  max_members: 8, members: names.map(name => member(name)) });

nodeTest('template validation accepts one to eight complete named members and rejects incomplete ones', () => {
  const five = validateLauncherTemplate(template(['frontend', 'backend', 'tester', 'reviewer', 'researcher']));
  assert.deepEqual(five.members.map(row => row.name), ['frontend', 'backend', 'tester', 'reviewer', 'researcher']);
  assert.equal(validateLauncherTemplate(template(['solo'])).members.length, 1);
  const incomplete = template(['frontend', 'backend']); delete incomplete.members[1].persona_prompt;
  assert.throws(() => validateLauncherTemplate(incomplete), { code: 'LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE' });
  assert.throws(() => validateLauncherTemplate(template(['lead'])), { code: 'INVALID_MEMBER_NAME' });
});

nodeTest('startup stream bounds are per member name and default to one when omitted', () => {
  const base = { mode: 'launcher', ownedSessionId: 'session-00000000-0000-4000-8000-000000000000', workspace: process.cwd(),
    runTag: 'multi-role', timeoutMs: 1000, templateSha256: '0'.repeat(64) };
  const parsed = parseLauncherConfig({ ...base, startup: { maxTokens: 1024, maxStreams: { frontend: 2, backend: 12 } } });
  assert.deepEqual(parsed.startup.maxStreams, { frontend: 2, backend: 12 });
  assert.deepEqual(parseLauncherConfig({ ...base, startup: { maxTokens: 1024, maxStreams: {} } }).startup.maxStreams, {});
  for (const maxStreams of [{ frontend: 0 }, { frontend: 13 }, { Lead: 1 }, { lead: 1 }, { frontend: 1.5 }]) {
    assert.throws(() => parseLauncherConfig({ ...base, startup: { maxTokens: 1024, maxStreams } }), { code: 'INVALID_LAUNCHER_CONFIG' });
  }
});

nodeTest('team authorization and gate derive the member set from controls, not a fixed pair', async () => {
  const roles = Object.fromEntries(['frontend', 'backend', 'tester'].map((name, index) => [name,
    { route: { provider: 'p', model: `m${index}`, reasoningEffort: 'max', maxTokens: 1024 }, maxStreams: 1 }]));
  const controls = { ownedSessionId: 'session-root', roles };
  assert.equal(authorizeTeam(controls, [{ provider: 'p', model: 'm0' }, { provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }]), true);
  assert.throws(() => authorizeTeam(controls, [{ provider: 'p', model: 'm0' }, { provider: 'p', model: 'm1' }]), { code: 'SESSION_ROUTE_NOT_AUTHORIZED' });
  const gate = createTeamGate(controls, { roleTools: { frontend: ['team_task_get'], backend: ['send_message'], tester: [] } });
  gate.track('tester', 'session-tester');
  assert.deepEqual(Object.keys(gate.evidence().roles), ['frontend', 'backend', 'tester']);
  assert.throws(() => gate.track('implementer', 'session-x'), { code: 'UNEXPECTED_CHILD' });
  assert.throws(() => createTeamGate(controls, { roleTools: { frontend: [] } }), { code: 'INVALID_TEAM_GATE_OPTIONS' });
});

test('launch creates every template member with its own Preset, exact tools and gate evidence', async t => {
  const host = await launcherHost(t, applyLauncher, { extraMembers: [
    { name: 'tester', native_tool_allowlist: ['team_task_get'] },
    { name: 'researcher', native_tool_allowlist: [] }] });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'success', result.text);
  assert.equal(host.catalog.size, 4);
  assert.equal(host.presets.size, 4);
  assert.deepEqual(result.value.members.map(row => row.name), ['implementer', 'reviewer', 'tester', 'researcher']);
  for (const row of result.value.members) {
    const spec = host.template.members.find(item => item.name === row.name);
    assert.equal(row.agentPreset, spec.agent_preset);
    assert.deepEqual([...row.tools].sort(), [...spec.native_tool_allowlist].sort());
    assert.ok(result.value.gate.roles[row.name].admissions > 0);
  }
  // Declaration order reversed: later members already run when earlier ones may message them.
  const spawns = host.order.filter(entry => entry.startsWith('spawn:'));
  assert.deepEqual(spawns, ['spawn:researcher', 'spawn:tester', 'spawn:reviewer', 'spawn:implementer']);
});

for (const [label, agent] of [['itself', 'tester'], ['the Lead', 'lead'], ['a name outside the template', 'designer']]) {
  test(`startup message from a member to ${label} is denied before the native body`, async t => {
    const host = await launcherHost(t, applyLauncher, { extraMembers: [{ name: 'tester', native_tool_allowlist: ['send_message'] }],
      extraWork: { tester: [{ name: 'send_message', arguments: { agent, message: 'hello' } }] } });
    const result = decode(await host.invoke('launch'));
    assert.equal(result.kind, 'error');
    const tester = result.value.members.find(row => row.name === 'tester');
    assert.deepEqual(tester.scopeDenials.map(row => row.reason), ['TEAM_MESSAGE_OUT_OF_SCOPE']);
  });
}
