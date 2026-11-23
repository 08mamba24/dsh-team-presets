import { bindRc5Fixture } from './fixtures/host-contract.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRosterRuntime } from '../src/member-roster-native.js';
import { readReplacementRecord, ensureReplacementBaseBinding } from '../src/member-replacement.js';
import { createReplacementStore, REPLACEMENT_OWNER } from '../src/replacement-store.js';
import { resolveLogicalTeamTarget } from '../src/team-addressing.js';
import { launcherTemplateFingerprint } from '../src/launcher-template.js';
import { validateLauncherTemplate } from '../src/launcher-config.js';

const ROOT = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUFFIX = 'a'.repeat(24);
const FRONTEND = 'session-11111111-1111-4111-8111-111111111111', BACKEND = 'session-22222222-2222-4222-8222-222222222222';
const member = (name, extra = {}) => ({ name, description: `${name} duty`, prompt: `Start ${name}.`, persona_prompt: `You are ${name}.`,
  agent_preset: `dsh-current-${SUFFIX}-${name}`, provider: 'p', model: 'm', reasoning_effort: 'max',
  native_tool_allowlist: ['team_task_get'], ...extra });
const researcher = (extra = {}) => { const value = member('researcher', extra); delete value.agent_preset; return value; };

function host({ tasks = [], startup = 'completed', models = ['m'], foreign = [], seedTasks = [], onObserve, onRegister } = {}) {
  const baseMembers = [member('frontend'), member('backend', { native_tool_allowlist: ['team_task_get', 'read'] })];
  const template = { template_schema: 'dsh-team-template/1', version: 1, name: 't', members: baseMembers, seed_tasks: seedTasks };
  const binding = JSON.stringify({ workspace: '/w', template });
  const settings = { revision: 1, records: { [ROOT]: structuredClone(ensureReplacementBaseBinding(readReplacementRecord(undefined), binding)) } };
  const children = new Map([[FRONTEND, 'frontend'], [BACKEND, 'backend'], ...foreign].map(([id, name]) => [id, { id, name, preset: `dsh-current-${SUFFIX}-${name}` }]));
  const root = { id: ROOT, session: { id: ROOT, header: {}, snapshotEvents: () => [
    { type: 'command/run', data: { name: 'dsh-team', args: 'launch', commandId: 'launch-1' } },
    { type: 'command/done', data: { kind: 'success', commandId: 'launch-1', text: JSON.stringify({ ok: true, mode: 'launch',
      templateFingerprint: launcherTemplateFingerprint(validateLauncherTemplate(template)),
      seedAssignments: seedTasks.map((seed, i) => ({ key: seed.key, taskId: `t${i + 1}`, owner: seed.owner ?? null })) }) } },
  ] } };
  const activations = [], registered = [], interrupts = [];
  const definitions = [{ name: 'team_task_get' }, { name: 'team_task_update' }, { name: 'read' }];
  const ctx = {
    agents: { get: id => id === ROOT ? root : undefined },
    agentTeams: { isEnabled: () => true, listTasks: () => tasks },
    sessionProjections: { stateOf: () => models.map(model => ({ provider: 'p', model })) },
    tools: { definitions: () => definitions },
    llm: { resolveCallConfig: async route => ({ ...route }) },
    settings: { describe: () => [{ ns: REPLACEMENT_OWNER, revision: settings.revision, value: { replacementRecords: structuredClone(settings.records) } }],
      async mutate(ns, ops, revision) {
        assert.equal(ns, REPLACEMENT_OWNER); assert.equal(revision, settings.revision);
        for (const op of ops) settings.records[op.path[1]] = structuredClone(op.value);
        settings.revision++;
      } },
    subagents: {
      async listDescendants() { return [...children.values()].map(child => ({ kind: 'child', id: child.id, parentId: ROOT, depth: 1,
        hasChildren: false, mode: 'continuable', activity: 'inactive', name: child.name, path: child.name })); },
      async startActivation(input) {
        activations.push(input); children.set(input.childId, { id: input.childId, name: input.name, preset: input.agentPreset });
        return { childId: input.childId, result: Promise.resolve({ stopReason: startup }), async dispose() {} };
      },
      interrupt(id) { interrupts.push(id); },
    },
    sessionQuery: { async observeSession(id) {
      onObserve?.(id);
      const child = children.get(id);
      return { header: { id, parentSession: ROOT, agentPreset: child.preset, cwd: '/w' }, events: [], inheritedEventCount: 0,
        projections: { values: { inbox: { 'next-turn': [], 'next-step': [] } } }, [Symbol.dispose]() {} };
    } },
  };
  const store = createReplacementStore(ctx.settings, ROOT);
  const runtime = createRosterRuntime(bindRc5Fixture(ctx), { ownedSessionId: ROOT, workspace: '/w', runTag: `current-${SUFFIX}`, timeoutMs: 1000 },
    { baseMembers, store, registerMember: async entry => { registered.push(entry.id); await onRegister?.(ctx); }, lifetimeSignal: new AbortController().signal });
  const signal = new AbortController().signal;
  return { ctx, runtime, settings, children, activations, registered, interrupts, root, signal,
    record: () => readReplacementRecord(settings.records[ROOT]),
    add: raw => runtime.addMember(root, signal, raw), remove: name => runtime.removeMember(root, signal, name) };
}

test('explicit add spawns one root-scoped member with its own Preset, route, tools and durable roster entry', async () => {
  const h = host();
  const result = await h.add(researcher({ native_tool_allowlist: ['read', 'team_task_get'] }));
  assert.equal(result.ok, true);
  assert.equal(result.agentPreset, `dsh-current-${SUFFIX}-researcher`);
  assert.deepEqual(result.tools, ['read', 'team_task_get']);
  assert.equal(h.activations.length, 1);
  const [activation] = h.activations;
  assert.deepEqual([activation.name, activation.agentPreset, activation.cwd, activation.parent], ['researcher', result.agentPreset, '/w', h.root]);
  assert.deepEqual(activation.agentOptions, { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 1024 });
  assert.equal(activation.childId, result.childId);
  const entry = h.record().membership[0];
  assert.deepEqual([entry.kind, entry.name, entry.phase, entry.childId], ['add', 'researcher', 'active', result.childId]);
  assert.deepEqual(h.registered, [entry.id]);
  assert.deepEqual(h.runtime.rosterOf(h.record()).members.map(row => row.name), ['frontend', 'backend', 'researcher']);
  // Reload re-registers the addition's Preset before a cold continuation.
  await h.runtime.restore(h.record());
  assert.deepEqual(h.registered, [entry.id, entry.id]);
});

test('remove retains unclaimed seed responsibilities until completion or explicit native reassignment', async () => {
  const tasks = [{ id: 't1', status: 'pending', revision: 1 }];
  const h = host({ tasks, seedTasks: [{ key: 'build', subject: 'Build', description: 'Work', owner: 'backend' }] });
  await assert.rejects(h.remove('backend'), e => e.code === 'MEMBER_HAS_UNFINISHED_TASKS' && e.taskIds.join() === 't1');
  tasks[0].ownerId = FRONTEND;
  assert.equal((await h.remove('backend')).ok, true);
});

test('remove rechecks native task responsibilities after quiescence, before the durable removal', async () => {
  const tasks = [], h = host({ tasks, onObserve() { tasks.push({ id: 'late', status: 'pending', ownerId: BACKEND }); } });
  await assert.rejects(h.remove('backend'), { code: 'MEMBER_HAS_UNFINISHED_TASKS' });
  assert.equal(h.record().membership, undefined);
});

test('Team mode withdrawal cannot make existing task responsibilities look empty', async () => {
  const h = host(); h.ctx.agentTeams.isEnabled = () => false;
  await assert.rejects(h.remove('backend'), { code: 'MEMBER_TEAM_NOT_LAUNCHED' });
  assert.equal(h.record().membership, undefined);
});

test('route authority revoked while registering the addition prevents any activation', async () => {
  const h = host({ onRegister(ctx) { ctx.sessionProjections.stateOf = () => []; } });
  await assert.rejects(h.add(researcher()), { code: 'SESSION_ROUTE_NOT_AUTHORIZED' });
  assert.equal(h.activations.length, 0);
  assert.equal(h.record().membership[0].phase, 'aborted');
});

for (const [label, raw, options, code] of [
  ['a template member name', () => member('backend'), {}, 'MEMBER_NAME_CONFLICT'],
  ['a foreign native child name', () => researcher(), { foreign: [['session-99999999-9999-4999-8999-999999999999', 'researcher']] }, 'MEMBER_NAME_CONFLICT'],
  ['an unauthorized route', () => researcher({ model: 'other' }), {}, 'SESSION_ROUTE_NOT_AUTHORIZED'],
  ['an unavailable tool', () => researcher({ native_tool_allowlist: ['bash'] }), {}, 'TEAM_TOOL_UNAVAILABLE'],
  ['an incomplete member', () => { const value = researcher(); delete value.persona_prompt; return value; }, {}, 'LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE'],
]) {
  test(`add with ${label} is refused before any write, Preset or spawn`, async () => {
    const h = host(options), before = h.settings.revision;
    await assert.rejects(h.add(raw()), { code });
    assert.equal(h.settings.revision, before);
    assert.deepEqual([h.activations.length, h.registered.length], [0, 0]);
  });
}

test('failed startup stops only the new member, keeps old members and tasks, and reserves the name', async () => {
  const tasks = [{ id: 't1', status: 'in_progress', ownerId: BACKEND }];
  const h = host({ startup: 'aborted', tasks });
  await assert.rejects(h.add(researcher()), error => error.code === 'MEMBER_STARTUP_NOT_COMPLETED' && error.memberStateConfirmed === true);
  assert.equal(h.record().membership[0].phase, 'failed');
  assert.ok(h.children.has(FRONTEND) && h.children.has(BACKEND));
  assert.deepEqual(tasks, [{ id: 't1', status: 'in_progress', ownerId: BACKEND }]);
  await assert.rejects(h.add(researcher()), { code: 'MEMBER_NAME_CONFLICT' });
  // The failed addition is still a quiet, task-free roster member and can be removed safely.
  assert.equal((await h.remove('researcher')).ok, true);
});

test('remove refuses unfinished owned tasks, then retires a quiet member and its addresses', async () => {
  const tasks = [{ id: 't1', status: 'in_progress', ownerId: BACKEND }, { id: 't2', status: 'completed', ownerId: FRONTEND }];
  const h = host({ tasks }), before = h.settings.revision;
  await assert.rejects(h.remove('backend'), error => error.code === 'MEMBER_HAS_UNFINISHED_TASKS' && error.taskIds.join() === 't1');
  assert.equal(h.settings.revision, before);
  await assert.rejects(h.remove('designer'), { code: 'MEMBER_NOT_FOUND' });
  tasks[0].status = 'completed';
  const result = await h.remove('backend');
  assert.deepEqual([result.ok, result.childId, result.retainedTaskIds], [true, BACKEND, ['t1', 't2']]);
  assert.deepEqual(h.runtime.rosterOf(h.record()).members.map(row => row.name), ['frontend']);
  assert.throws(() => resolveLogicalTeamTarget(h.record(), 'backend'), { code: 'TEAM_MEMBER_REMOVED' });
  assert.throws(() => resolveLogicalTeamTarget(h.record(), BACKEND), { code: 'TEAM_MEMBER_RETIRED' });
  assert.equal(resolveLogicalTeamTarget(h.record(), 'frontend'), 'frontend');
  await assert.rejects(h.add(member('backend')), { code: 'MEMBER_NAME_CONFLICT' });
});
