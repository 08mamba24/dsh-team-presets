import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTeamGate } from '../src/team-gate.js';
import { parseTeamConfig, TEAM_ROLE_TOOLS } from '../src/team-config.js';

const config = () => ({
  mode: 'team', ownedSessionId: 'session-20000000-0000-4000-8000-000000000001',
  workspace: '/tmp/dsh-launcher-gate-test', runTag: 'launcher-gate-test', timeoutMs: 120000,
  roles: Object.fromEntries(['implementer', 'reviewer'].map((role, index) => [role, {
    memberName: `gate-${role}`, presetId: `dsh-team-gate-${role}`, personaNonce: `persona-launcher-gate-${role}`,
    maxStreams: index === 0 ? 6 : 5,
    route: { provider: 'deepseek-account', model: index === 0 ? 'deepseek-flash' : 'deepseek-v4-pro',
      reasoningEffort: 'low', maxTokens: 1024 },
  }])),
});
const masks = () => ({
  implementer: ['team_task_get', 'team_task_update', 'send_message'],
  reviewer: ['team_task_get', 'team_task_update', 'wait_agent'],
});
const consume = async iterable => { for await (const _ of iterable) {} };
const toolSchemas = names => names.map(name => ({ name, description: 'synthetic native tool', parameters: {} }));
const toolResult = id => ({ id, role: 'tool', source: { kind: 'tool', callId: `call-${id}` },
  toolCallId: `call-${id}`, isError: false, content: [{ type: 'text', text: 'native result' }] });
const request = (c, role, names, messages = []) => ({ ...c.roles[role].route,
  sessionId: `child-${role}`, tools: toolSchemas(names), messages });
const stream = async function* () {
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
function fixture(options) {
  const c = parseTeamConfig(config()), gate = createTeamGate(c, options);
  gate.track('implementer', 'child-implementer'); gate.track('reviewer', 'child-reviewer');
  return { c, gate };
}

test('one shared gate admits two distinct explicit three-tool role masks', async () => {
  const roleTools = masks(), { c, gate } = fixture({ roleTools });
  for (const role of ['implementer', 'reviewer']) {
    const names = [...roleTools[role]].reverse();
    await consume(gate.hook(request(c, role, names), stream));
    const evidence = gate.evidence(role);
    assert.equal(evidence.admissions, 1);
    assert.deepEqual(evidence.toolNames, names);
    assert.equal(evidence.requiredToolsPresent, true);
    assert.deepEqual(evidence.usage, { inputTokens: 8, outputTokens: 5, totalTokens: 13 });
  }
});

test('an explicit empty mask admits an exactly empty prepared tool set', async () => {
  const { c, gate } = fixture({ roleTools: { implementer: [], reviewer: [] } });
  await consume(gate.hook(request(c, 'implementer', []), stream));
  await consume(gate.hook(request(c, 'reviewer', []), stream));
  assert.deepEqual(gate.evidence('implementer').toolNames, []);
  assert.equal(gate.evidence('reviewer').admissions, 1);
});

test('missing, excessive, duplicated or other-role tools fail before provider dispatch', async () => {
  for (const names of [
    ['team_task_get', 'team_task_update'],
    [...masks().implementer, 'wait_agent'],
    ['team_task_get', 'team_task_get', 'send_message'],
    masks().reviewer,
    ['team_task_get', 'team_task_update', 'bash'],
  ]) {
    const { c, gate } = fixture({ roleTools: masks() });
    let calls = 0;
    await assert.rejects(consume(gate.hook(request(c, 'implementer', names), async function* () {
      calls++; yield* stream();
    })), /TEAM_ROLE_TOOLS_CHANGED/);
    assert.equal(calls, 0);
    assert.equal(gate.evidence('implementer').admissions, 0);
  }
});

test('invalid option, role and tool shapes return one stable code without echoing input', () => {
  const invalid = [null, {}, [], { roleTools: null }, { roleTools: [] },
    { roleTools: { implementer: [] } },
    { roleTools: { ...masks(), lead: [] } },
    { roleTools: masks(), rootQuarantine: false },
    { roleTools: { ...masks(), reviewer: 'wait_agent' } },
    { roleTools: { ...masks(), reviewer: ['wait_agent', 'wait_agent'] } },
    { roleTools: { ...masks(), reviewer: ['private-secret-sentinel'] } },
    { roleTools: { ...masks(), reviewer: [undefined] } },
    { roleTools: { ...masks(), reviewer: Array(1) } },
    { roleTools: { ...masks(), reviewer: [null] } },
    { roleTools: { ...masks(), reviewer: [42] } },
  ];
  const symbolOption = { roleTools: masks(), [Symbol('private-secret-sentinel')]: true };
  invalid.push(symbolOption);
  for (const options of invalid) {
    assert.throws(() => createTeamGate(parseTeamConfig(config()), options), error => {
      assert.equal(error.code, 'INVALID_TEAM_GATE_OPTIONS');
      assert.equal(error.message.includes('private-secret-sentinel'), false);
      return true;
    });
  }
});

test('constructor snapshots masks so later caller mutation cannot expand or shrink admission', async () => {
  const roleTools = masks(), options = { roleTools }, { c, gate } = fixture(options);
  roleTools.implementer.push('bash');
  roleTools.reviewer.splice(0, roleTools.reviewer.length);
  options.roleTools = { implementer: [], reviewer: [] };
  await consume(gate.hook(request(c, 'implementer', masks().implementer), stream));
  await consume(gate.hook(request(c, 'reviewer', masks().reviewer), stream));
  assert.deepEqual(gate.evidence('implementer').toolNames, masks().implementer);
  assert.deepEqual(gate.evidence('reviewer').toolNames, masks().reviewer);
});

test('omitted options preserve the exact accepted four-tool M2 mask', async () => {
  const c = parseTeamConfig(config()), gate = createTeamGate(c);
  gate.track('implementer', 'child-implementer'); gate.track('reviewer', 'child-reviewer');
  for (const role of ['implementer', 'reviewer']) {
    await consume(gate.hook(request(c, role, TEAM_ROLE_TOOLS), stream));
    assert.deepEqual(gate.evidence(role).toolNames, TEAM_ROLE_TOOLS);
  }
  const h = fixture();
  await assert.rejects(consume(h.gate.hook(request(h.c, 'implementer', masks().implementer),
    () => assert.fail('default M2 admitted a reduced mask'))), /TEAM_ROLE_TOOLS_CHANGED/);
  assert.throws(() => parseTeamConfig({ ...config(), roleTools: masks() }), /INVALID_TEAM_CONFIG/);
});

test('default request allowance, retry refusal and closed admission retain their prior semantics', async () => {
  const { c, gate } = fixture();
  const messages = [];
  for (let i = 0; i < c.roles.implementer.maxStreams; i++) {
    if (i) messages.push(toolResult(`step-${i}`));
    await consume(gate.hook(request(c, 'implementer', TEAM_ROLE_TOOLS, messages), stream));
  }
  await assert.rejects(consume(gate.hook(request(c, 'implementer', TEAM_ROLE_TOOLS,
    [...messages, toolResult('over-budget')]), () => assert.fail('budget expanded'))), /REQUEST_ALLOWANCE_USED/);
  const retry = fixture();
  await consume(retry.gate.hook(request(retry.c, 'implementer', TEAM_ROLE_TOOLS), stream));
  await assert.rejects(consume(retry.gate.hook(request(retry.c, 'implementer', TEAM_ROLE_TOOLS),
    () => assert.fail('retry admitted'))), /OWNED_STREAM_RETRY_DISABLED/);
  const closed = fixture();
  closed.gate.close('TIMEOUT'); closed.gate.close('REPLACEMENT');
  assert.equal(closed.gate.evidence().closeReason, 'TIMEOUT');
  await assert.rejects(consume(closed.gate.hook(request(closed.c, 'reviewer', TEAM_ROLE_TOOLS),
    () => assert.fail('closed admission reached provider'))), /TEAM_GATE_CLOSED/);
});

test('explicit masks do not change root quarantine, causal attribution or unrelated passthrough', async () => {
  const { c, gate } = fixture({ roleTools: masks() });
  await assert.rejects(consume(gate.hook({ sessionId: c.ownedSessionId },
    () => assert.fail('root reached provider'))), /ROOT_QUARANTINED/);
  await assert.rejects(gate.run(() => consume(gate.hook({ sessionId: 'unattributed-child' },
    () => assert.fail('unattributed owned work reached provider')))), /UNATTRIBUTED_OWNED_REQUEST/);
  gate.close('CANCELLED');
  let unrelated = 0;
  await consume(gate.hook({ sessionId: 'unrelated-daily-session' }, async function* () {
    unrelated++; yield { type: 'text', text: 'untouched' };
  }));
  assert.equal(unrelated, 1);
});
