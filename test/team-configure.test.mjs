import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyTeamConfigurator } from '../src/team-configure.js';
import { nativeEffectOwner } from './fixtures/native-effect-owner.mjs';

const base = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
const changes = [
  { name: 'implementer', provider: 'codeagent', model: 'build-model', reasoning_effort: 'max', persona_prompt: 'Build with evidence.' },
  { name: 'reviewer', provider: 'codeagent', model: 'review-model', reasoning_effort: 'high' },
];
async function fixture(t, options = {}) {
  const tools = new Map(), skills = new Map(), metadata = [], writes = [];
  const owner = nativeEffectOwner();
  const registered = new Map(['team_task_get', 'team_task_update', 'send_message', 'wait_agent',
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'mcp_example_lookup', 'spawn_agent', 'run_code',
    'plugin_manager', 'workflow', 'ralph', 'subagent_fork']
    .map(name => [name, { name, description: `Registered ${name}` }]));
  let revision = 3, template = structuredClone(base), approvals = 0;
  const controller = new AbortController();
  const root = { id: 'root', session: { id: 'root', header: {} } };
  const ctx = {
    tools: {
      definitions(scope) { return [...registered.values()].filter(row => scope === undefined || row.name !== options.restrictedTool); },
      register(tool) { return owner.effect(() => { tools.set(tool.name, tool); return () => tools.delete(tool.name); }); },
    },
    skills: { register(skill) { return owner.effect(() => { skills.set(skill.name, skill); return () => skills.delete(skill.name); }); } },
    settings: {
      describe() { return [{ ns: 'dsh-native-current-team', revision, value: { template: structuredClone(template) } }]; },
      async update(ns, patch, expected) {
        assert.equal(ns, 'dsh-native-current-team');
        if (expected !== revision) throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' });
        assert.deepEqual(Object.keys(patch), ['template']);
        template = structuredClone(patch.template); revision++;
        writes.push(structuredClone(patch));
        if (options.writeUnconfirmed) throw new Error('readback unavailable');
      },
    },
    sessionProjections: { stateOf() { return [{ provider: 'codeagent', model: 'build-model' }]; } },
    llm: {
      listProviders() { return [{ id: 'codeagent', name: 'Configured provider' }]; },
      async listModels(provider) { assert.equal(provider, 'codeagent'); return [{ id: 'build-model', name: 'Builder' }]; },
      async resolveCallConfig(route) { metadata.push(route); if (options.unsupported) throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_REASONING_EFFORT' }); return { ...route }; },
    },
    sandboxPolicy: { resolve() { return { mode: 'workspace-write' }; } },
    get() { return undefined; },
    effect: owner.effect,
  };
  const launcher = {
    defaultTemplate: () => structuredClone(base),
    assertRoot(agent) { if (agent !== root) throw Object.assign(new Error('root only'), { code: 'WRONG_AGENT' }); },
    hasBinding: () => options.bound ?? false,
  };
  await applyTeamConfigurator(ctx, launcher, {
    defineTool: x => x,
    async approveEscalation() { approvals++; if (options.denied) throw Object.assign(new Error('denied'), { code: 'APPROVAL_DENIED' }); if (options.concurrent) revision++; if (options.cancelled) controller.abort(); if (options.removeOnApproval) registered.delete(options.removeOnApproval); },
  });
  const configured = tools.get('dsh_team_configure');
  const invoke = async (args, agent = root) => JSON.parse(await configured.execute(args,
    { agent, signal: controller.signal, callId: 'config-call' }));
  t.after(() => owner.dispose());
  return { invoke, tools, skills, metadata, writes, root, dispose: owner.dispose, removeTool: name => registered.delete(name),
    get template() { return template; }, get approvals() { return approvals; } };
}

test('registered management and recursive tools are absent from the catalog and cannot be saved for a role', async t => {
  const f = await fixture(t), catalog = await f.invoke({ action: 'tools' });
  for (const name of ['plugin_manager', 'workflow', 'ralph', 'subagent_fork']) {
    assert.equal(catalog.tools.some(tool => tool.name === name), false);
    const preview = await f.invoke({ action: 'preview', expectedRevision: 3,
      members: [{ name: 'implementer', native_tool_allowlist: [name] }] });
    assert.equal(preview.ok, false);
  }
  assert.deepEqual(f.writes, []); assert.deepEqual(f.metadata, []); assert.equal(f.approvals, 0);
});

test('the profile-wide skill and inspection need no metadata lookup, model call or settings write', async t => {
  const f = await fixture(t);
  assert.ok(f.skills.get('dsh-team-configure').content.includes('dsh_team_configure'));
  const result = await f.invoke({ action: 'inspect' });
  assert.equal(result.ok, true); assert.equal(result.revision, 3);
  assert.equal(result.template.members[0].reasoning_effort, 'max');
  assert.deepEqual(f.metadata, []); assert.deepEqual(f.writes, []); assert.equal(f.approvals, 0);
});

test('preview validates selected provider/model/effort without granting authorization or writing', async t => {
  const f = await fixture(t);
  const result = await f.invoke({ action: 'preview', expectedRevision: 3, members: changes });
  assert.equal(result.ok, true);
  assert.deepEqual(f.metadata.map(x => x.reasoningEffort), ['max', 'high']);
  assert.deepEqual(result.currentSessionAuthorization.map(x => x.authorized), [true, false]);
  assert.equal(f.writes.length, 0); assert.equal(f.approvals, 0);
});

test('apply persists the previewed template through native settings CAS and preserves tools/tasks', async t => {
  const f = await fixture(t, { bound: true });
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members: changes });
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members: changes });
  assert.equal(result.ok, true); assert.equal(result.persisted, true); assert.equal(result.revision, 4);
  assert.equal(result.currentSessionNeedsNewRoot, true); assert.equal(result.existingMembersChanged, false);
  assert.equal(f.approvals, 1); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.template.seed_tasks, base.seed_tasks);
  assert.deepEqual(f.template.members.map(m => m.native_tool_allowlist), base.members.map(m => m.native_tool_allowlist));
  assert.equal(f.template.members[0].persona_prompt, 'Build with evidence.');
});

test('stale revision or fingerprint and unsupported effort refuse before permission or writes', async t => {
  const f = await fixture(t);
  for (const args of [
    { action: 'preview', expectedRevision: 2, members: changes },
    { action: 'apply', expectedRevision: 3, expectedFingerprint: '0'.repeat(64), members: changes },
  ]) assert.equal((await f.invoke(args)).ok, false);
  assert.equal(f.writes.length, 0); assert.equal(f.approvals, 0);
  const unsupported = await fixture(t, { unsupported: true });
  assert.equal((await unsupported.invoke({ action: 'preview', expectedRevision: 3, members: changes })).code, 'UNSUPPORTED_REASONING_EFFORT');
  assert.equal(unsupported.writes.length, 0);
});

test('permission refusal, cancellation and concurrent settings changes never overwrite configuration', async t => {
  for (const option of ['denied', 'cancelled', 'concurrent']) {
    const f = await fixture(t, { [option]: true });
    const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members: changes });
    const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members: changes });
    assert.equal(result.ok, false, option); assert.equal(f.writes.length, 0, option);
  }
});

test('write uncertainty is reported without compensation or automatic retry', async t => {
  const f = await fixture(t, { writeUnconfirmed: true });
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members: changes });
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members: changes });
  assert.equal(result.code, 'TEAM_CONFIGURATION_WRITE_UNCONFIRMED');
  assert.equal(result.noAutomaticRetry, true); assert.equal(f.writes.length, 1);
});

test('model catalog selection and root-only editing reject malformed or foreign requests', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.invoke({ action: 'models', provider: 'codeagent' })).models.map(m => m.id), ['build-model']);
  for (const members of [[{ name: 'lead', model: 'x' }], [changes[0], changes[0]], [{ ...changes[0], native_tool_allowlist: ['shell'] }]]) {
    assert.equal((await f.invoke({ action: 'preview', expectedRevision: 3, members })).ok, false);
  }
  assert.equal((await f.invoke({ action: 'inspect' }, { session: { header: { origin: 'subagent' } } })).code, 'WRONG_AGENT');
  assert.equal(f.writes.length, 0);
});

test('tool catalog exposes registered tools visible to the root, excluding delegation and reserved transports', async t => {
  const f = await fixture(t, { restrictedTool: 'write' });
  const result = await f.invoke({ action: 'tools' });
  assert.equal(result.ok, true);
  const names = result.tools.map(tool => tool.name);
  assert.ok(names.includes('read')); assert.ok(names.includes('mcp_example_lookup'));
  assert.equal(names.includes('write'), false);
  assert.equal(names.includes('spawn_agent'), false); assert.equal(names.includes('run_code'), false);
  assert.deepEqual(f.metadata, []); assert.deepEqual(f.writes, []);
});

test('role tool edits preview and persist exact tool names without changing peer, models or tasks', async t => {
  const f = await fixture(t);
  const members = [{ name: 'implementer', native_tool_allowlist: ['team_task_get', 'read', 'write', 'bash', 'mcp_example_lookup'] }];
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.template.members[0].native_tool_allowlist, members[0].native_tool_allowlist);
  assert.deepEqual(f.metadata, []); assert.equal(f.writes.length, 0);
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members });
  assert.equal(result.persisted, true); assert.equal(f.approvals, 1);
  assert.deepEqual(f.template.members[0].native_tool_allowlist, members[0].native_tool_allowlist);
  assert.deepEqual(f.template.members[1], base.members[1]); assert.deepEqual(f.template.seed_tasks, base.seed_tasks);
});

test('unknown, restricted and orchestration tools refuse before approval or persistence', async t => {
  const f = await fixture(t, { restrictedTool: 'write' });
  for (const tool of ['unknown_tool', 'write', 'spawn_agent', 'run_code', 'dsh_team_configure']) {
    const result = await f.invoke({ action: 'preview', expectedRevision: 3,
      members: [{ name: 'reviewer', native_tool_allowlist: [tool] }] });
    assert.equal(result.ok, false, tool);
  }
  assert.deepEqual(f.metadata, []); assert.equal(f.approvals, 0); assert.equal(f.writes.length, 0);
});

test('tool removal between preview/apply or while native approval is pending does not save an unavailable selection', async t => {
  for (const duringApproval of [false, true]) {
    const f = await fixture(t, { removeOnApproval: duringApproval ? 'read' : undefined });
    const members = [{ name: 'reviewer', native_tool_allowlist: ['read'] }];
    const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members });
    assert.equal(preview.ok, true);
    if (!duringApproval) f.removeTool('read');
    const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members });
    assert.equal(result.ok, false); assert.equal(result.code, 'TEAM_TOOL_UNAVAILABLE');
    assert.equal(f.writes.length, 0);
  }
});

test('plugin unload unregisters the runtime skill and rejects a captured old configuration tool', async t => {
  const f = await fixture(t);
  assert.ok(f.skills.get('dsh-team-configure').content.includes('native_tool_allowlist'));
  await f.dispose();
  assert.equal(f.skills.size, 0); assert.equal(f.tools.size, 0);
  assert.equal((await f.invoke({ action: 'inspect' })).code, 'UNLOADING');
});
