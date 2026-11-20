import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamConfig, preflightTeam, TEAM_ROLE_TOOLS } from '../src/team-config.js';
import { createTeamGate } from '../src/team-gate.js';
import { apply as applyRole } from '../team-role.js';
import { applyTeam } from '../src/team-driver.js';
import { CONTROL_ENTRY } from './fixtures/control-entry.mjs';

// Native tools.restrict validates ancestor/global definitions, not just a requested allow array.
// Preset registrations are ancestor layers of a composed child; agent-own registrations are exempt from masking.
function nativeToolScope() {
  const ancestor = new Set(['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']);
  const own = new Set(), restrictions = [];
  const registerControl = (scope = 'preset', config = { interrupt: false }) => {
    const target = scope === 'preset' ? ancestor : own;
    for (const name of ['list_agents', 'wait_agent', 'send_message']) target.add(name);
    if (config.interrupt !== false) target.add('interrupt_agent');
  };
  const tools = {
    restrict(filter) {
      if (filter.allow === undefined && filter.deny === undefined) throw new Error('tools.restrict({}) is a no-op');
      const unknown = [...filter.allow ?? [], ...filter.deny ?? []].filter(name => !ancestor.has(name));
      if (unknown.length) throw new Error(`tools.restrict() names unknown global tools ${unknown.map(name => `"${name}"`).join(', ')}; known global tools: ${[...ancestor].sort().join(', ')}`);
      const record = { ...filter, allow: filter.allow && [...filter.allow], deny: filter.deny && [...filter.deny] };
      restrictions.push(record); return () => restrictions.splice(restrictions.indexOf(record), 1);
    },
    resolve() { assert.fail('Team ownership is not registered during agent/created'); },
  };
  return { tools, registerControl, restrictions,
    visibleNames: () => [...new Set([...ancestor].filter(name => restrictions.every(filter =>
      (filter.allow === undefined || filter.allow.includes(name)) && !filter.deny?.includes(name))).concat([...own]))].sort(),
    ancestorNames: () => [...ancestor].sort() };
}

async function pairPresetDefinitions(t, controlEntry = { name: CONTROL_ENTRY, config: { interrupt: false } }) {
  const definitions = [], disposers = [], noop = () => {};
  const ctx = { agents: { get: noop }, sessionProjections: { stateOf: noop },
    agentTeams: Object.fromEntries(['isEnabled', 'setEnabled', 'createTask', 'getTask', 'listTasks'].map(name => [name, noop])),
    subagents: { interrupt: noop }, agentPresets: { async register(definition) { definitions.push(definition); return noop; } },
    on: () => noop, commands: { register: () => noop }, effect(generator) { for (const dispose of generator()) disposers.push(dispose); } };
  await applyTeam(ctx, example(), { apply: noop }, controlEntry);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  return definitions;
}

async function startPreset(definition) {
  const scope = nativeToolScope(), hooks = [];
  let parentSession;
  for (const entry of definition.plugins) {
    if (entry.name === CONTROL_ENTRY) {
      assert.deepEqual(entry.config, { interrupt: false }); scope.registerControl('preset', entry.config);
    } else if (entry.name === 'dsh-subagent-live-rc2-local/team-role') {
      parentSession = entry.config.ownedSessionId;
      await applyRole({ systemPrompt: { section() {} }, on(name, callback) {
        assert.equal(name, 'agent/created'); hooks.push(callback);
      } }, entry.config);
    } else throw new Error('the synthetic external profile cannot resolve this preset entry');
  }
  const agent = { session: { header: { origin: 'subagent', parentSession } }, ctx: { tools: scope.tools } };
  for (const callback of hooks) callback({ agent });
  return scope;
}

const example = () => ({
  mode: 'team', ownedSessionId: 'session-20000000-0000-4000-8000-000000000001',
  workspace: '/tmp/dsh-owned-team-test', runTag: 'team-pair-test', timeoutMs: 120000,
  roles: {
    implementer: { memberName: 'team-implementer', presetId: 'dsh-live-team-implementer',
      personaNonce: 'persona-team-implementer-a1', maxStreams: 6,
      route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 1024 } },
    reviewer: { memberName: 'team-reviewer', presetId: 'dsh-live-team-reviewer',
      personaNonce: 'persona-team-reviewer-b2', maxStreams: 5,
      route: { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'low', maxTokens: 1024 } },
  },
});
const consume = async iterable => { for await (const _ of iterable) {} };
const tools = () => TEAM_ROLE_TOOLS.map(name => ({ name, description: 'native fixture', parameters: {} }));
const result = id => ({ id, role: 'tool', source: { kind: 'tool', callId: `call-${id}` },
  toolCallId: `call-${id}`, isError: false, content: [{ type: 'text', text: 'native result' }] });
const request = (c, role, messages = []) => ({ ...c.roles[role].route, sessionId: `child-${role}`, tools: tools(), messages });
const stream = async function* () {
  // The later usage chunk replaces this stream's interim value, rather than being added twice.
  yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
function gateFixture() {
  const config = parseTeamConfig(example()), gate = createTeamGate(config);
  gate.track('implementer', 'child-implementer'); gate.track('reviewer', 'child-reviewer');
  return { config, gate };
}

test('team plan requires explicit distinct roles, models, presets and immutable controls', () => {
  const raw = example(), parsed = parseTeamConfig(raw);
  raw.roles.reviewer.route.model = 'mutated';
  assert.equal(parsed.roles.reviewer.route.model, 'deepseek-v4-pro');
  assert.ok(Object.isFrozen(parsed.roles) && Object.isFrozen(parsed.roles.reviewer) && Object.isFrozen(parsed.roles.reviewer.route));
  for (const change of [
    x => { delete x.mode; },
    x => { x.roles.reviewer.memberName = x.roles.implementer.memberName; },
    x => { x.roles.reviewer.presetId = x.roles.implementer.presetId; },
    x => { x.roles.reviewer.personaNonce = x.roles.implementer.personaNonce; },
    x => { x.roles.reviewer.route = { ...x.roles.implementer.route, provider: 'another-provider' }; },
    x => { x.roles.reviewer.route.provider = 'deepseek-official'; },
    x => { x.roles.implementer.maxStreams = 7; },
    x => { x.roles.reviewer.route.maxTokens = 4096; },
    x => { x.roles.reviewer.route.reasoningEffort = 'max'; },
    x => { x.roles.reviewer.route.apiKey = 'not-a-config-field'; },
  ]) {
    const altered = example(); change(altered); assert.throws(() => parseTeamConfig(altered));
  }
});

test('a missing reviewer authorization prevents even implementer metadata lookup', async () => {
  const c = parseTeamConfig(example()); let lookups = 0;
  await assert.rejects(preflightTeam(c, [c.roles.implementer.route],
    { resolveCallConfig() { lookups++; assert.fail('unauthorized pair must not perform I/O'); } },
    new AbortController().signal), /SESSION_ROUTE_NOT_AUTHORIZED/);
  assert.equal(lookups, 0);
  const calls = [];
  await assert.rejects(preflightTeam(c, Object.values(c.roles).map(x => x.route),
    { async resolveCallConfig(route) { calls.push(route); return { ...route, maxTokens: undefined }; } },
    new AbortController().signal), /RESOLVED_CONTROLS_CHANGED/);
  assert.equal(calls.length, 1);
});

test('each role has its own normal-step allowance and summed final usage per stream', async () => {
  const { config: c, gate } = gateFixture();
  for (const role of ['implementer', 'reviewer']) {
    const messages = [];
    for (let i = 0; i < c.roles[role].maxStreams; i++) {
      if (i) messages.push(result(`${role}-${i}`));
      await consume(gate.hook(request(c, role, messages), stream));
    }
    const evidence = gate.evidence(role);
    assert.equal(evidence.admissions, c.roles[role].maxStreams);
    assert.deepEqual(evidence.usage, { inputTokens: 8 * evidence.admissions,
      outputTokens: 5 * evidence.admissions, totalTokens: 13 * evidence.admissions });
    assert.equal(evidence.requiredToolsPresent, true);
    assert.deepEqual(evidence.toolNames, TEAM_ROLE_TOOLS);
    assert.ok(evidence.streams.every(x => x.completed));
  }
  await assert.rejects(consume(gate.hook(request(c, 'implementer', [result('over-budget')]),
    () => assert.fail('seventh implementer stream reached adapter'))), /REQUEST_ALLOWANCE_USED/);
});

test('identical history cannot become an automatic retry and failed native tools are terminal', async () => {
  const { config: c, gate } = gateFixture();
  await consume(gate.hook(request(c, 'implementer'), stream));
  await assert.rejects(consume(gate.hook(request(c, 'implementer'),
    () => assert.fail('retry reached adapter'))), /OWNED_STREAM_RETRY_DISABLED/);
  assert.equal(gate.evidence('implementer').admissions, 1);
  const other = gateFixture();
  await consume(other.gate.hook(request(other.config, 'reviewer'), stream));
  await assert.rejects(consume(other.gate.hook(request(other.config, 'reviewer',
    [{ ...result('failed'), isError: true }]), () => assert.fail('tool failure was retried'))), /TEAM_TOOL_FAILED/);
});

test('native tool results may omit optional isError, while malformed error flags are refused', async () => {
  const { config: c, gate } = gateFixture();
  await consume(gate.hook(request(c, 'reviewer'), stream));
  const nativeResult = { id: 'native-result-1', role: 'tool',
    source: { kind: 'tool', callId: 'native-call-1' }, toolCallId: 'native-call-1',
    content: [{ type: 'text', text: '{"timedOut":false}' }] };
  await consume(gate.hook(request(c, 'reviewer', [nativeResult]), stream));
  assert.equal(gate.evidence('reviewer').admissions, 2);
  const h = gateFixture();
  await consume(h.gate.hook(request(h.config, 'implementer'), stream));
  await assert.rejects(consume(h.gate.hook(request(h.config, 'implementer',
    [{ ...nativeResult, isError: 'false' }]), () => assert.fail('malformed tool result reached adapter'))), /TEAM_TOOL_RESULT_INVALID/);
});

test('quarantine, causal attribution, tool leakage and route drift refuse before provider dispatch', async () => {
  const cases = [
    [r => ({ ...r, sessionId: example().ownedSessionId }), 'ROOT_QUARANTINED'],
    [r => ({ ...r, purpose: 'title' }), 'AUXILIARY_DISABLED'],
    [r => ({ ...r, provider: 'wrong-provider' }), 'DISPATCH_CONTROLS_CHANGED'],
    [r => ({ ...r, tools: [...r.tools, { name: 'bash' }] }), 'TEAM_ROLE_TOOLS_CHANGED'],
    [r => ({ ...r, tools: r.tools.filter(x => x.name !== 'wait_agent') }), 'TEAM_ROLE_TOOLS_CHANGED'],
  ];
  for (const [change, code] of cases) {
    const { config, gate } = gateFixture();
    await assert.rejects(consume(gate.hook(change(request(config, 'implementer')),
      () => assert.fail('forbidden dispatch reached adapter'))), new RegExp(code));
  }
  const { gate } = gateFixture();
  await assert.rejects(gate.run(() => consume(gate.hook({ sessionId: 'anonymous-child' },
    () => assert.fail('unattributed dispatch reached adapter')))), /UNATTRIBUTED_OWNED_REQUEST/);
  let unrelated = 0;
  await consume(gate.hook({ sessionId: 'daily-unrelated' }, async function* () { unrelated++; yield { type: 'text', text: 'untouched' }; }));
  assert.equal(unrelated, 1);
});

test('a failed or overlapping owned stream cannot admit more work', async () => {
  const { config: c, gate } = gateFixture();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const running = consume(gate.hook(request(c, 'implementer'), async function* () { await waiting; yield* stream(); }));
  await assert.rejects(consume(gate.hook(request(c, 'implementer'),
    () => assert.fail('concurrent request reached adapter'))), /CONCURRENT_OWNED_STREAM/);
  release(); await running;
  await assert.rejects(consume(gate.hook(request(c, 'reviewer'),
    () => assert.fail('failed pair admitted another member request'))), /TEAM_GATE_FAILED/);
});

test('close synchronously fences both children despite spare budgets and fresh successful tool results', async () => {
  const { config: c, gate } = gateFixture();
  for (const role of ['implementer', 'reviewer']) await consume(gate.hook(request(c, role), stream));
  assert.equal(gate.evidence().closed, false);
  gate.close('TIMEOUT');
  gate.close('UNLOADING');
  assert.equal(gate.evidence().closed, true);
  assert.equal(gate.evidence().closeReason, 'TIMEOUT');
  assert.equal(gate.evidence().failure, undefined, 'closing is an admission fence, not a fabricated stream failure');
  let dispatched = 0;
  for (const role of ['implementer', 'reviewer']) {
    await assert.rejects(consume(gate.hook(request(c, role, [result(`late-${role}`)]),
      async function* () { dispatched++; yield* stream(); })), /TEAM_GATE_CLOSED/);
    assert.equal(gate.evidence(role).admissions, 1);
    assert.equal(gate.evidence(role).closed, true);
    assert.equal(gate.evidence(role).closeReason, 'TIMEOUT');
  }
  assert.equal(dispatched, 0);
});

test('close preserves an already admitted drain, unrelated traffic, and the root quarantine', async () => {
  const { config: c, gate } = gateFixture();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const draining = new Promise(resolve => { release = resolve; });
  const chunks = [];
  const running = (async () => {
    for await (const chunk of gate.hook(request(c, 'implementer'), async function* () {
      entered(); await draining; yield* stream();
    })) chunks.push(chunk);
  })();
  await started;
  gate.close('CANCELLED');
  assert.equal(gate.evidence().failure, undefined);
  assert.equal(gate.evidence('implementer').streams[0].completed, false);
  let unrelated = 0;
  await consume(gate.hook({ sessionId: 'daily-unrelated' }, async function* () { unrelated++; yield { type: 'text', text: 'untouched' }; }));
  await assert.rejects(consume(gate.hook({ sessionId: c.ownedSessionId },
    () => assert.fail('closing removed the root quarantine'))), /ROOT_QUARANTINED/);
  release(); await running;
  assert.equal(unrelated, 1);
  assert.equal(chunks.length, 3);
  assert.equal(gate.evidence('implementer').streams[0].completed, true);
  assert.deepEqual(gate.evidence('implementer').usage, { inputTokens: 8, outputTokens: 5, totalTokens: 13 });
  assert.equal(gate.evidence().failure, undefined);
});

test('close refuses a late child association without inventing an activation or stream failure', () => {
  const c = parseTeamConfig(example()), gate = createTeamGate(c);
  gate.track('implementer', 'child-implementer');
  gate.close('UNLOADING');
  assert.throws(() => gate.track('reviewer', 'late-child'), /TEAM_GATE_CLOSED/);
  assert.equal(gate.evidence('reviewer').childId, undefined);
  assert.equal(gate.evidence('reviewer').admissions, 0);
  assert.equal(gate.evidence().failure, undefined);
  assert.equal(gate.evidence().denials.length, 0);
});

test('role creation restricts native capabilities without resolving Team ownership too early', async () => {
  const c = parseTeamConfig(example()); let created, persona, restriction;
  await applyRole({ systemPrompt: { section(value) { persona = value.text; } },
    on(name, callback) { assert.equal(name, 'agent/created'); created = callback; } },
  { ownedSessionId: c.ownedSessionId, runTag: c.runTag, role: 'reviewer', personaNonce: c.roles.reviewer.personaNonce });
  assert.ok(persona.includes(c.roles.reviewer.personaNonce) && persona.includes('reviewer') && persona.includes('wait_agent'));
  const scope = nativeToolScope(); scope.registerControl('preset', { interrupt: false });
  const agent = { session: { header: { origin: 'subagent', parentSession: c.ownedSessionId } },
    ctx: { tools: { ...scope.tools, restrict(value) { restriction = value; return scope.tools.restrict(value); } } } };
  created({ agent });
  assert.deepEqual(restriction, { allow: [...TEAM_ROLE_TOOLS] });
  assert.deepEqual(scope.visibleNames(), [...TEAM_ROLE_TOOLS].sort());
  assert.throws(() => created({ agent: { ...agent, session: { header: { origin: 'subagent', parentSession: 'foreign-root' } } } }), /ROLE_WRONG_PARENT/);
});

for (const role of ['implementer', 'reviewer']) {
  test(`PRESET_STARTUP registered ${role} includes native control definitions before its role hook`, async t => {
    const definitions = await pairPresetDefinitions(t), config = example();
    const definition = definitions.find(item => item.id === config.roles[role].presetId);
    assert.ok(definition);
    const scope = await startPreset(definition);
    assert.deepEqual(scope.visibleNames(), [...TEAM_ROLE_TOOLS].sort());
    assert.equal(definition.plugins[0].name, CONTROL_ENTRY);
    assert.deepEqual(definition.plugins[0].config, { interrupt: false });
  });
}

test('PRESET_STARTUP native control in a preset ancestor permits exactly the existing four capabilities', async t => {
  const [definition] = await pairPresetDefinitions(t);
  const candidate = { ...definition, plugins: [
    { id: `${definition.id}-native-control`, name: CONTROL_ENTRY, config: { interrupt: false } },
    ...definition.plugins.filter(entry => entry.name !== CONTROL_ENTRY),
  ] };
  const scope = await startPreset(candidate);
  assert.ok(scope.ancestorNames().includes('list_agents'));
  assert.equal(scope.ancestorNames().includes('interrupt_agent'), false);
  assert.deepEqual(scope.visibleNames(), [...TEAM_ROLE_TOOLS].sort());
  assert.equal(scope.visibleNames().includes('team_task_create'), false);
  assert.equal(scope.visibleNames().includes('team_task_list'), false);
  assert.equal(scope.visibleNames().includes('list_agents'), false);
});

test('PRESET_STARTUP child-own control registrations cannot stand in for a native preset entry', () => {
  const scope = nativeToolScope(); scope.registerControl('agent', { interrupt: false });
  assert.throws(() => scope.tools.restrict({ allow: [...TEAM_ROLE_TOOLS] }), /unknown global tools "send_message", "wait_agent"/);
  scope.tools.restrict({ allow: [] });
  assert.deepEqual(scope.visibleNames(), ['list_agents', 'send_message', 'wait_agent'], 'own registrations bypass an inherited/global mask');
});

test('PRESET_STARTUP M2 control binding refuses missing, external, queried or interrupt-enabled entries', async t => {
  for (const entry of [null, {},
    { name: 'https://example.test/control.js', config: { interrupt: false } },
    { name: 'file:///tmp/control/lib/index.js', config: { interrupt: false } },
    { name: `${CONTROL_ENTRY}?token=synthetic-secret`, config: { interrupt: false } },
    { name: CONTROL_ENTRY, config: { interrupt: true } },
  ]) await assert.rejects(pairPresetDefinitions(t, entry), /NATIVE_CONTROL_ENTRY_UNAVAILABLE/);
});
