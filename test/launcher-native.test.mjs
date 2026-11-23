import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeLauncherMembers, registerLauncherPresets, makeLauncherSpawnCall, parseLauncherSpawnBatch } from '../src/launcher-native.js';
import { planLauncherMembers } from '../src/launcher-plan.js';
import { CONTROL } from './fixtures/control-entry.mjs';

const ROOT = { id: 'session-launcher-owned' };
const member = () => ({ name: 'implementer', description: 'Implementation role', prompt: 'Perform the supplied task',
  provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low', agentPreset: 'dsh-team-implementer',
  personaPrompt: 'Use the supplied implementation requirements.', nativeToolAllowlist: ['team_task_get', 'team_task_update', 'send_message'] });
const row = () => ({ kind: 'child', id: 'child-implementer', parentId: ROOT.id, depth: 1, path: 'implementer',
  name: 'implementer', mode: 'continuable', label: member().description, activity: 'inactive', hasChildren: false });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Public DTO and service boundaries only; no native Host, Session, provider or prompt assembly is started.
function observationFixture(rows = [row()]) {
  const agents = new Map(), stats = { catalogReads: 0, liveReads: 0, resolves: 0, disposals: 0, creates: 0, wakes: 0 };
  const ctx = {
    subagents: { async listDescendants(id, signal) { assert.equal(id, ROOT.id); assert.ok(signal instanceof AbortSignal); stats.catalogReads++; return rows; },
      start() { stats.creates++; assert.fail('observation created a member'); },
      sendMessage() { stats.wakes++; assert.fail('observation woke a member'); }, interrupt() { assert.fail('observation interrupted a member'); } },
    agents: { get(id) { stats.liveReads++; return agents.get(id); }, list() { assert.fail('live registry is not catalog discovery'); } },
    agentPresets: { composedPreset(scope) { return scope.preset; } },
    systemPrompt: { assemble() { assert.fail('observation assembled a prompt'); } },
  };
  const makeAgent = () => {
    const selected = { provider: member().provider, model: member().model, reasoningEffort: member().reasoningEffort };
    const agent = { id: 'child-implementer', status: 'idle', session: { id: 'child-implementer', header: { origin: 'subagent', parentSession: ROOT.id, agentPreset: 'not-a-fallback-proof' } },
      model: { current: () => selected }, ctx: { preset: member().agentPreset, tools: {} } };
    Object.defineProperty(agent, 'options', { get() { assert.fail('do not inspect fallback/default options'); } });
    const toolSet = { view(exact) { assert.equal(exact, agent); return new Map(member().nativeToolAllowlist.map(name => [name, {}])); }, dispose() { stats.disposals++; } };
    agent.ctx.tools.resolve = async input => { stats.resolves++; assert.equal(input.agent, agent); assert.equal(input.modelSelection, selected); return toolSet; };
    return { agent, toolSet, selected };
  };
  return { ctx, agents, stats, makeAgent };
}

test('empty durable catalog is the only absence basis and never enumerates or wakes live agents', async () => {
  const h = observationFixture([]), result = await observeLauncherMembers(h.ctx, ROOT);
  assert.deepEqual(result, { complete: true, members: [], anonymousForeignIds: [], reason: 'NATIVE_CATALOG_COMPLETE' });
  assert.deepEqual(h.stats, { catalogReads: 1, liveReads: 0, resolves: 0, disposals: 0, creates: 0, wakes: 0 });
});

test('live fields use the exact public handles and resolved tool set but never prove persona or durable route', async () => {
  const h = observationFixture(), live = h.makeAgent(); h.agents.set(live.agent.id, live.agent);
  const result = await observeLauncherMembers(h.ctx, ROOT), observed = result.members[0];
  assert.equal(result.complete, true); assert.equal(observed.description, row().label);
  assert.equal(observed.agentPreset, member().agentPreset); assert.equal(observed.provider, member().provider);
  assert.equal(observed.routeEvidence, 'effective-next-step-only'); assert.equal(Object.hasOwn(observed, 'personaPrompt'), false);
  assert.deepEqual(observed.unobservableFields, ['personaPrompt']);
  assert.deepEqual(observed.nativeToolAllowlist, [...member().nativeToolAllowlist].sort());
  assert.equal(h.stats.resolves, 1); assert.equal(h.stats.disposals, 1);
  const plan = planLauncherMembers({ templateSchema: 'dsh-team-template/1', members: [member()] }, result);
  assert.equal(plan.members[0].action, 'conflict'); assert.ok(plan.members[0].unverifiableFields.includes('personaPrompt'));
  assert.equal(h.stats.creates, 0); assert.equal(h.stats.wakes, 0);
});

test('diagnostics, contradictory ancestry or names and duplicate identities block the entire catalog', async () => {
  for (const rows of [undefined,
    [{ kind: 'diagnostic', id: 'child-bad', parentId: ROOT.id, depth: 1, reason: 'corrupt' }],
    [{ ...row(), path: undefined }], [{ ...row(), parentId: 'different-parent' }],
    [{ ...row(), depth: 2, parentId: 'other-child', path: 'other/implementer' }],
    [{ ...row(), name: undefined }], [{ ...row(), name: 'reviewer' }],
    [{ ...row(), hasChildren: 'false' }], [{ ...row(), activity: undefined }],
    [row(), { ...row(), name: 'reviewer', path: 'reviewer' }],
    [row(), { ...row(), id: 'child-other' }],
    [row(), { ...row(), id: 'child-descendant', parentId: row().id, depth: 2, name: 'checker', path: 'implementer/checker' }],
    [{ ...row(), hasChildren: true }, { kind: 'diagnostic', id: 'child-bad', parentId: row().id, depth: 2, path: 'implementer/checker', reason: 'unavailable' }],
  ]) {
    const h = observationFixture(); h.ctx.subagents.listDescendants = async () => rows;
    const result = await observeLauncherMembers(h.ctx, ROOT);
    assert.deepEqual(result, { complete: false, members: [], reason: 'NATIVE_CATALOG_INCOMPLETE' }); assert.equal(h.stats.liveReads, 0);
  }
  const h = observationFixture(); h.ctx.subagents.listDescendants = async () => { throw new Error('private native detail'); };
  assert.deepEqual(await observeLauncherMembers(h.ctx, ROOT), { complete: false, members: [], reason: 'NATIVE_CATALOG_UNAVAILABLE' });
});

test('a cold catalog member stays present and absent labels are never fabricated from headers or names', async () => {
  for (const mode of ['continuable', 'external', 'one-shot']) {
    const catalogRow = { ...row(), mode }; delete catalogRow.label;
    const h = observationFixture([catalogRow]), result = await observeLauncherMembers(h.ctx, ROOT);
    assert.equal(result.complete, true); assert.equal(result.members.length, 1); assert.equal(result.members[0].id, row().id);
    for (const field of ['description', 'agentPreset', 'provider', 'model', 'nativeToolAllowlist', 'personaPrompt']) assert.equal(Object.hasOwn(result.members[0], field), false);
    const plan = planLauncherMembers({ templateSchema: 'dsh-team-template/1', members: [member()] }, result);
    assert.equal(plan.members[0].action, 'conflict'); assert.equal(h.stats.creates, 0); assert.equal(h.stats.wakes, 0);
  }
});

test('normal foreign descendants do not become direct roles or prevent planning two new named members', async () => {
  const foreign = { ...row(), id: 'foreign-parent', name: 'foreign', path: 'foreign', hasChildren: true };
  const descendant = { ...row(), id: 'foreign-descendant', parentId: foreign.id, depth: 2, path: 'foreign/implementer' };
  const h = observationFixture([foreign, descendant]), result = await observeLauncherMembers(h.ctx, ROOT);
  assert.equal(result.complete, true); assert.deepEqual(result.members.map(value => value.name), ['foreign']);
  assert.deepEqual(result.anonymousForeignIds, []);
  const reviewer = { ...member(), name: 'reviewer', description: 'Review role' };
  const plan = planLauncherMembers({ templateSchema: 'dsh-team-template/1', members: [member(), reviewer] }, result);
  assert.deepEqual(plan.members.map(value => value.action), ['create', 'create']);
  assert.deepEqual(plan.foreignMembers, [{ id: foreign.id, name: 'foreign' }]); assert.equal(plan.blocked, false);
  assert.equal(h.stats.creates, 0); assert.equal(h.stats.wakes, 0);
});

test('legal anonymous foreign ids are preserved outside planner members without inventing role names', async () => {
  const anonymous = { ...row(), id: 'anonymous-parent', name: undefined, path: undefined, hasChildren: true };
  const descendant = { ...row(), id: 'anonymous-descendant', parentId: anonymous.id, depth: 2, name: 'reviewer', path: undefined };
  const h = observationFixture([anonymous, descendant]), result = await observeLauncherMembers(h.ctx, ROOT);
  assert.equal(result.complete, true); assert.deepEqual(result.members, []);
  assert.deepEqual(result.anonymousForeignIds, ['anonymous-parent']); assert.equal(h.stats.liveReads, 0);
  const plan = planLauncherMembers({ templateSchema: 'dsh-team-template/1', members: [member(), { ...member(), name: 'reviewer' }] }, result);
  assert.deepEqual(plan.members.map(value => value.action), ['create', 'create']); assert.equal(plan.blocked, false);
  assert.equal(h.stats.creates, 0); assert.equal(h.stats.wakes, 0);
});

test('wrong live parent and busy live state never resolve tools or substitute header preset identity', async () => {
  for (const change of [agent => { agent.session.header.parentSession = 'foreign-root'; }, agent => { agent.session.header.origin = 'user'; }]) {
    const h = observationFixture(), live = h.makeAgent(); change(live.agent); h.agents.set(live.agent.id, live.agent);
    const [observed] = (await observeLauncherMembers(h.ctx, ROOT)).members;
    assert.equal(observed.agentPreset, undefined); assert.equal(observed.provider, undefined); assert.equal(h.stats.resolves, 0);
  }
  const h = observationFixture(), live = h.makeAgent(); live.agent.status = 'running'; h.agents.set(live.agent.id, live.agent);
  const [observed] = (await observeLauncherMembers(h.ctx, ROOT)).members;
  assert.equal(observed.status, 'running'); assert.equal(observed.nativeToolAllowlist, undefined); assert.equal(h.stats.resolves, 0);
});

test('resolve, view and disposal exceptions withhold tool fields and dispose every obtained set', async () => {
  for (const stage of ['resolve', 'view', 'dispose']) {
    const h = observationFixture(), live = h.makeAgent(); h.agents.set(live.agent.id, live.agent);
    if (stage === 'resolve') live.agent.ctx.tools.resolve = async () => { throw new Error('private resolve error'); };
    if (stage === 'view') live.toolSet.view = () => { throw new Error('private view error'); };
    if (stage === 'dispose') live.toolSet.dispose = () => { h.stats.disposals++; throw new Error('private dispose error'); };
    const result = await observeLauncherMembers(h.ctx, ROOT);
    assert.equal(result.complete, true); assert.equal(result.members[0].nativeToolAllowlist, undefined);
    assert.equal(h.stats.disposals, stage === 'resolve' ? 0 : 1); assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('replacement or route drift while resolving tools invalidates live facts and still disposes the set', async () => {
  for (const mutation of ['replace', 'route']) {
    const h = observationFixture(), live = h.makeAgent(), entered = deferred(), ready = deferred();
    h.agents.set(live.agent.id, live.agent); live.agent.ctx.tools.resolve = async () => { entered.resolve(); return ready.promise; };
    const observation = observeLauncherMembers(h.ctx, ROOT); await entered.promise;
    if (mutation === 'replace') h.agents.set(live.agent.id, h.makeAgent().agent);
    else live.agent.model.current = () => ({ ...live.selected, model: 'different-next-step' });
    ready.resolve(live.toolSet); const [observed] = (await observation).members;
    assert.equal(observed.nativeToolAllowlist, undefined); assert.equal(observed.provider, undefined);
    assert.equal(observed.agentPreset, undefined); assert.equal(h.stats.disposals, 1);
  }
});

test('cancellation during a read returns no partial catalog and disposes its prepared tool set', async () => {
  const h = observationFixture(), live = h.makeAgent(), entered = deferred(), ready = deferred(), controller = new AbortController();
  h.agents.set(live.agent.id, live.agent); live.agent.ctx.tools.resolve = async () => { entered.resolve(); return ready.promise; };
  const observation = observeLauncherMembers(h.ctx, ROOT, controller.signal); await entered.promise; controller.abort(); ready.resolve(live.toolSet);
  assert.deepEqual(await observation, { complete: false, members: [], reason: 'NATIVE_CATALOG_UNAVAILABLE' }); assert.equal(h.stats.disposals, 1);
});

test('preset registration supplies native control then generic persona and keeps ownership until explicit disposal', async () => {
  const definitions = [], disposed = [], first = member(), second = { ...member(), name: 'reviewer', agentPreset: 'dsh-team-reviewer',
    personaPrompt: 'Review independently.', nativeToolAllowlist: ['team_task_get', 'team_task_update', 'wait_agent'] };
  for (const value of [first, second]) Object.defineProperty(value, 'prompt', { get() { assert.fail('registration must not inspect startup prompt'); } });
  const ctx = { agentPresets: { async register(definition) { definitions.push(definition); return () => { disposed.push(definition.id); }; } } };
  const disposers = await registerLauncherPresets(ctx, { ownedSessionId: ROOT.id }, { members: [first, second] }, CONTROL);
  assert.equal(disposers.length, 2); assert.deepEqual(disposed, []);
  for (const [index, value] of [first, second].entries()) {
    assert.equal(definitions[index].id, value.agentPreset);
    assert.deepEqual(definitions[index].plugins[0], { id: `${value.agentPreset}-native-control`, name: CONTROL.name, config: { interrupt: false } });
    assert.deepEqual(definitions[index].plugins[1], { id: `${value.agentPreset}-persona`, name: 'dsh-subagent-live-rc2-local/launcher-role',
      config: { ownedSessionId: ROOT.id, roleName: value.name, personaPrompt: value.personaPrompt, tools: value.nativeToolAllowlist } });
  }
  for (const dispose of disposers.reverse()) await dispose(); assert.deepEqual(disposed, ['dsh-team-reviewer', 'dsh-team-implementer']);
});

test('partial registration failure rolls back only returned native disposers in reverse order even if cleanup rejects', async () => {
  for (const cleanupRejects of [false, true]) {
    const disposed = [], roles = [member(), { ...member(), name: 'reviewer', agentPreset: 'dsh-team-reviewer' },
      { ...member(), name: 'checker', agentPreset: 'dsh-team-checker' }];
    const ctx = { agentPresets: { async register(definition) {
      if (definition.id === 'dsh-team-checker') throw new Error('private native registration detail');
      return async () => { disposed.push(definition.id); if (cleanupRejects && definition.id === 'dsh-team-reviewer') throw new Error('private cleanup'); };
    } } };
    await assert.rejects(registerLauncherPresets(ctx, { ownedSessionId: ROOT.id }, { members: roles }, CONTROL), error =>
      error.code === 'LAUNCHER_PRESET_REGISTRATION_FAILED' && Boolean(error.cleanupFailed) === cleanupRejects && !String(error).includes('private'));
    assert.deepEqual(disposed, ['dsh-team-reviewer', 'dsh-team-implementer']);
  }
});

test('registration refuses absent persona/tools, duplicate presets and unguarded control before any writes', async () => {
  let registered = 0; const ctx = { agentPresets: { register() { registered++; assert.fail('invalid input registered a preset'); } } };
  for (const members of [[{ ...member(), personaPrompt: undefined }], [{ ...member(), nativeToolAllowlist: undefined }],
    [member(), { ...member(), name: 'reviewer' }]]) {
    await assert.rejects(registerLauncherPresets(ctx, { ownedSessionId: ROOT.id }, { members }, CONTROL), error => error.code === 'LAUNCHER_PRESET_INPUT_INVALID');
  }
  await assert.rejects(registerLauncherPresets(ctx, {}, {}, { name: 'https://invalid.test/control', config: { interrupt: false } }), /NATIVE_CONTROL_ENTRY_UNAVAILABLE/);
  assert.equal(registered, 0);
});

test('spawn construction uses only explicit selected values and creates unique native call identities', () => {
  const value = member(); Object.defineProperty(value, 'prompt', { get() { assert.fail('do not infer a startup prompt'); } });
  Object.defineProperty(value, 'personaPrompt', { get() { assert.fail('spawn call must not inspect persona'); } });
  const call = makeLauncherSpawnCall(value, { workspace: '/tmp/owned-workspace', prompt: 'A supplied startup request' });
  assert.equal(call.type, 'tool-call'); assert.equal(call.name, 'dsh_team_launcher_spawn');
  assert.match(call.id, /^dsh-team-launcher-[a-f0-9-]{36}$/);
  assert.deepEqual(JSON.parse(call.arguments), { name: value.name, description: value.description,
    provider: value.provider, model: value.model, reasoning_effort: 'low', agent_preset: value.agentPreset, prompt: 'A supplied startup request' });
  assert.notEqual(makeLauncherSpawnCall(value, { workspace: '/tmp/owned-workspace', prompt: 'Another request' }).id, call.id);
  for (const bad of [{ ...member(), reasoningEffort: undefined }, { ...member(), agentPreset: undefined }]) {
    assert.throws(() => makeLauncherSpawnCall(bad, { workspace: '/tmp/owned', prompt: 'request' }), error => error.code === 'LAUNCHER_SPAWN_INPUT_INVALID');
  }
  assert.throws(() => makeLauncherSpawnCall(member(), { workspace: 'relative', prompt: 'request' }), /LAUNCHER_SPAWN_INPUT_INVALID/);
});

test('batch parsing reuses strict execution-result checks, projects activation only and never reads call arguments', () => {
  const value = member(), call = makeLauncherSpawnCall(value, { workspace: '/tmp/owned', prompt: 'request' });
  Object.defineProperty(call, 'arguments', { get() { assert.fail('batch parser must not inspect a full prompt'); } });
  const success = { results: [{ callId: call.id, result: { isError: false, value: { kind: 'activation', name: value.name, privateExtra: 'not forwarded' } } }], additionalContexts: [], concluded: false };
  assert.deepEqual(parseLauncherSpawnBatch(success, call, value), { ok: true, activation: { kind: 'activation', name: value.name }, callId: call.id });
  delete success.results[0].result.isError;
  assert.deepEqual(parseLauncherSpawnBatch(success, call, value).delegationFailure.mismatches, ['RESULT_ERROR_FLAG']);
  const failed = { results: [{ callId: call.id, result: { isError: true,
    error: { info: { name: 'Error', code: 'TOOL_ERROR' }, message: 'token=never-forward-this-credential' }, content: [{ text: 'private prompt' }] } }], additionalContexts: [], concluded: false };
  const result = parseLauncherSpawnBatch(failed, call, value);
  assert.equal(result.ok, false); assert.equal(result.code, 'NATIVE_DELEGATION_FAILED');
  assert.equal(result.delegationFailure.nativeError.message, 'Native error message omitted');
  assert.equal(JSON.stringify(result).includes('never-forward'), false); assert.equal(JSON.stringify(result).includes('private prompt'), false);
});
