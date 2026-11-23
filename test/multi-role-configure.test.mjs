import { bindRc5Fixture } from './fixtures/host-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyTeamConfigurator } from '../src/team-configure.js';
import * as roleTemplates from '../src/role-templates.js';
import { nativeEffectOwner } from './fixtures/native-effect-owner.mjs';

const base = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
const implementerTemplate = roleTemplates.resolveRoleTemplate('implementer');
const customRecord = id => ({ id, description: `Custom ${id}`, persona_prompt: `Custom ${id} persona.`,
  prompt: `Custom ${id} prompt.`,
  // Sorted: the duty-template library normalizes tool lists to sorted order.
  native_tool_allowlist: ['read', 'team_task_get'] });

async function fixture(t, options = {}) {
  const tools = new Map(), skills = new Map(), metadata = [], writes = [];
  const owner = nativeEffectOwner();
  const registered = new Map(['team_task_get', 'team_task_update', 'send_message', 'wait_agent',
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'mcp_example_lookup', 'spawn_agent', 'run_code']
    .map(name => [name, { name, description: `Registered ${name}` }]));
  let revision = 3, template = structuredClone(options.rowTemplate ?? base), approvals = 0;
  let customs = 'rowCustoms' in options ? structuredClone(options.rowCustoms) : null;
  const controller = new AbortController();
  const root = { id: 'root', session: { id: 'root', header: {} } };
  const ctx = {
    tools: {
      definitions(scope) { return [...registered.values()].filter(row => scope === undefined || row.name !== options.restrictedTool); },
      register(tool) { return owner.effect(() => { tools.set(tool.name, tool); return () => tools.delete(tool.name); }); },
    },
    skills: { register(skill) { return owner.effect(() => { skills.set(skill.name, skill); return () => skills.delete(skill.name); }); } },
    settings: {
      describe() { return [{ ns: 'dsh-native-current-team', revision,
        value: { template: structuredClone(template), ...(customs === null ? {} : { customRoleTemplates: structuredClone(customs) }) } }]; },
      async update(ns, patch, expected) {
        assert.equal(ns, 'dsh-native-current-team');
        if (expected !== revision) throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' });
        assert.deepEqual(Object.keys(patch), ['template', 'customRoleTemplates']);
        template = structuredClone(patch.template); customs = structuredClone(patch.customRoleTemplates); revision++;
        writes.push(structuredClone(patch));
        if (options.writeUnconfirmed) throw new Error('readback unavailable');
      },
    },
    sessionProjections: { stateOf() { return [{ provider: 'codeagent', model: 'build-model' }]; } },
    llm: {
      listProviders() { return [{ id: 'codeagent', name: 'Configured provider' }]; },
      async listModels(provider) { assert.equal(provider, 'codeagent'); return [{ id: 'build-model', name: 'Builder' }]; },
      async resolveCallConfig(route) { metadata.push(route); return { ...route }; },
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
  await applyTeamConfigurator(bindRc5Fixture(ctx), launcher, {
    // Registration-contract lint standing in for the physical Host compiler:
    // nested object schemas without an explicit boolean additionalProperties
    // are rejected there (real RED: native-multi-integrated-r2.log).
    defineTool(definition) {
      const walk = node => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node === null || typeof node !== 'object') return;
        if (node.type === 'object') assert.equal(typeof node.additionalProperties, 'boolean',
          `object schema needs explicit additionalProperties: ${JSON.stringify(node).slice(0, 120)}`);
        for (const value of Object.values(node)) walk(value);
      };
      walk(definition.parameters);
      return definition;
    },
    async approveEscalation() { approvals++; if (options.denied) throw Object.assign(new Error('denied'), { code: 'APPROVAL_DENIED' }); if (options.concurrent) revision++; if (options.cancelled) controller.abort(); if (options.removeOnApproval) registered.delete(options.removeOnApproval); },
  }, { roleTemplates: options.library === null ? null : options.library ?? roleTemplates,
    defaultCustomTemplates: options.defaultCustoms });
  const configured = tools.get('dsh_team_configure');
  const invoke = async (args, agent = root) => JSON.parse(await configured.execute(args,
    { agent, signal: controller.signal, callId: 'config-call' }));
  t.after(() => owner.dispose());
  return { invoke, tools, skills, metadata, writes, root, dispose: owner.dispose, removeTool: name => registered.delete(name),
    get template() { return template; }, get customs() { return customs; }, get approvals() { return approvals; } };
}

const route = { provider: 'codeagent', model: 'build-model', reasoning_effort: 'max' };

test('roles lists the six built-in duty templates and saved customs without writes', async t => {
  const f = await fixture(t);
  const listed = await f.invoke({ action: 'roles' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.templates.filter(row => row.source === 'built-in').map(row => row.id),
    ['architect', 'implementer', 'reviewer', 'tester', 'researcher', 'designer']);
  const implementer = listed.templates.find(row => row.id === 'implementer');
  for (const shell of ['bash', 'pwsh']) assert.ok(implementer.native_tool_allowlist.includes(shell));
  assert.deepEqual(listed.templates.filter(row => row.source === 'custom'), []);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.metadata, []); assert.equal(f.approvals, 0);
});

test('duty templates are explicitly unavailable without the wired library while inspect keeps working', async t => {
  const f = await fixture(t, { library: null });
  const inspect = await f.invoke({ action: 'inspect' });
  assert.equal(inspect.ok, true); assert.equal(inspect.roleTemplatesAvailable, false);
  assert.equal('templates' in inspect, false);
  assert.equal((await f.invoke({ action: 'roles' })).code, 'ROLE_TEMPLATES_UNAVAILABLE');
  assert.equal((await f.invoke({ action: 'preview', expectedRevision: 3,
    members: [{ name: 'frontend', ...route, role: 'implementer' }] })).code, 'ROLE_TEMPLATES_UNAVAILABLE');
  const legacy = await f.invoke({ action: 'preview', expectedRevision: 3,
    members: [{ name: 'implementer', persona_prompt: 'Still works.' }] });
  assert.equal(legacy.ok, true); assert.deepEqual(f.writes, []);
});

test('adding members two-to-four persists synthesized presets, routes and seed tasks unchanged', async t => {
  const f = await fixture(t);
  const members = [
    { name: 'frontend', ...route, description: 'Frontend build', prompt: 'Frontend startup',
      persona_prompt: 'Frontend persona', native_tool_allowlist: ['team_task_get', 'read'] },
    { name: 'backend', ...route, model: 'review-model', reasoning_effort: 'high', description: 'Backend build',
      prompt: 'Backend startup', persona_prompt: 'Backend persona',
      native_tool_allowlist: ['team_task_get', 'team_task_update', 'send_message', 'grep'] },
  ];
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.template.members.map(row => row.name), ['implementer', 'reviewer', 'frontend', 'backend']);
  assert.equal(preview.template.members[2].agent_preset, 'dsh-team-frontend');
  assert.equal(preview.template.max_members, 4);
  assert.deepEqual(f.metadata.map(item => item.model), ['build-model', 'review-model']);
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members });
  assert.equal(result.persisted, true); assert.equal(result.revision, 4);
  assert.deepEqual(f.template.seed_tasks, base.seed_tasks);
  assert.deepEqual(f.template.members[0], base.members[0]);
  assert.equal(f.approvals, 1); assert.equal(f.writes.length, 1);
});

test('two members sharing one duty template keep distinct routes, prompts and tools', async t => {
  const f = await fixture(t);
  const members = [
    { name: 'frontend', ...route, role: 'implementer', native_tool_allowlist: ['team_task_get', 'read'] },
    { name: 'backend', ...route, model: 'review-model', role: 'implementer',
      native_tool_allowlist: ['team_task_get', 'team_task_update', 'send_message', 'wait_agent', 'grep'] },
  ];
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members });
  assert.equal(preview.ok, true);
  const [frontend, backend] = preview.template.members.slice(2);
  assert.equal(frontend.role, 'implementer'); assert.equal(backend.role, 'implementer');
  assert.equal(frontend.persona_prompt, backend.persona_prompt);
  assert.equal(frontend.description, backend.description);
  assert.notDeepEqual(frontend.native_tool_allowlist, backend.native_tool_allowlist);
  assert.notEqual(frontend.model, backend.model);
  assert.notEqual(frontend.agent_preset, backend.agent_preset);
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members });
  assert.equal(result.persisted, true);
  const saved = f.template.members.slice(2);
  assert.notDeepEqual(saved[0].native_tool_allowlist, saved[1].native_tool_allowlist);
  assert.equal(saved[0].role, 'implementer'); assert.equal(saved[1].role, 'implementer');
});

test('adds beyond the declared cap require an explicit maxMembers raise in the same preview', async t => {
  const f = await fixture(t);
  const five = ['frontend', 'backend', 'api'].map(name => ({ name, ...route,
    description: `Duty ${name}`, prompt: `${name} startup`, persona_prompt: `${name} persona`,
    native_tool_allowlist: ['team_task_get', 'read'] }));
  const refused = await f.invoke({ action: 'preview', expectedRevision: 3, members: five });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'TEMPLATE_MEMBER_LIMIT');
  assert.deepEqual(f.writes, []); assert.equal(f.approvals, 0);
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, maxMembers: 8, members: five });
  assert.equal(preview.ok, true); assert.equal(preview.template.max_members, 8);
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint,
    maxMembers: 8, members: five });
  assert.equal(result.persisted, true); assert.equal(f.template.max_members, 8);
  assert.equal(f.template.members.length, 5);
});

test('removing a seed-task owner is refused; removing a plain added member persists', async t => {
  const f = await fixture(t);
  const ownerRemoval = await f.invoke({ action: 'preview', expectedRevision: 3, removeMembers: ['implementer'] });
  assert.equal(ownerRemoval.ok, false); assert.equal(ownerRemoval.code, 'SEED_TASK_OWNER_REMOVED');
  const unknown = await f.invoke({ action: 'preview', expectedRevision: 3, removeMembers: ['ghost'] });
  assert.equal(unknown.code, 'INVALID_MEMBER_REMOVALS');
  assert.deepEqual(f.writes, []); assert.equal(f.approvals, 0);
  const add = [{ name: 'tester', ...route, role: 'tester' }];
  const addPreview = await f.invoke({ action: 'preview', expectedRevision: 3, members: add });
  assert.equal((await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: addPreview.fingerprint, members: add })).persisted, true);
  const removal = await f.invoke({ action: 'preview', expectedRevision: 4, removeMembers: ['tester'] });
  assert.equal(removal.ok, true);
  assert.deepEqual(removal.template.members.map(row => row.name), ['implementer', 'reviewer']);
  const result = await f.invoke({ action: 'apply', expectedRevision: 4, expectedFingerprint: removal.fingerprint, removeMembers: ['tester'] });
  assert.equal(result.persisted, true);
  assert.deepEqual(f.template.members.map(row => row.name), ['implementer', 'reviewer']);
  assert.deepEqual(f.template.seed_tasks, base.seed_tasks);
});

test('explicit seed reassignment unlocks the installed-default four-member path', async t => {
  const f = await fixture(t);
  const seeds = [
    { ...base.seed_tasks[0], owner: 'frontend' },
    { ...base.seed_tasks[1], owner: 'reviewer' },
  ];
  const members = [
    { name: 'frontend', ...route, role: 'implementer', native_tool_allowlist: ['read', 'team_task_get', 'team_task_update', 'send_message'] },
    { name: 'backend', ...route, role: 'implementer', native_tool_allowlist: ['grep', 'read', 'send_message', 'team_task_get', 'team_task_update'] },
    { name: 'tester', ...route, role: 'tester' },
  ];
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3,
    removeMembers: ['implementer'], members, seedTasks: seeds });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.template.members.map(row => row.name), ['reviewer', 'frontend', 'backend', 'tester']);
  assert.deepEqual(preview.template.seed_tasks.map(task => [task.key, task.owner]),
    [['implement-work-item', 'frontend'], ['review-work-item', 'reviewer']]);
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint,
    removeMembers: ['implementer'], members, seedTasks: seeds });
  assert.equal(result.persisted, true);
  assert.deepEqual(f.template.members.map(row => row.name), ['reviewer', 'frontend', 'backend', 'tester']);
  assert.equal(f.template.seed_tasks[0].owner, 'frontend');
  assert.equal(f.approvals, 1); assert.equal(f.writes.length, 1);
});

test('seed reassignment keeps the removal guard for lingering, unknown or malformed owners', async t => {
  const f = await fixture(t);
  const stillOwned = [{ ...base.seed_tasks[0], owner: 'implementer' }];
  const lingering = await f.invoke({ action: 'preview', expectedRevision: 3,
    removeMembers: ['implementer'], seedTasks: stillOwned });
  assert.equal(lingering.ok, false); assert.equal(lingering.code, 'SEED_TASK_OWNER_REMOVED');
  const unknownOwner = await f.invoke({ action: 'preview', expectedRevision: 3,
    seedTasks: [{ ...base.seed_tasks[0], owner: 'ghost' }] });
  assert.equal(unknownOwner.ok, false); assert.equal(unknownOwner.code, 'INVALID_TASK_OWNER');
  const badBlocker = await f.invoke({ action: 'preview', expectedRevision: 3,
    seedTasks: [{ ...base.seed_tasks[0], blocked_by: ['missing-task'] }] });
  assert.equal(badBlocker.ok, false); assert.equal(badBlocker.code, 'UNKNOWN_TASK_DEPENDENCY');
  const duplicateKey = await f.invoke({ action: 'preview', expectedRevision: 3,
    seedTasks: [structuredClone(base.seed_tasks[0]), structuredClone(base.seed_tasks[0])] });
  assert.equal(duplicateKey.ok, false); assert.equal(duplicateKey.code, 'DUPLICATE_TASK_KEY');
  const empty = await f.invoke({ action: 'preview', expectedRevision: 3, seedTasks: [] });
  assert.equal(empty.ok, true); assert.deepEqual(empty.template.seed_tasks, []);
  assert.deepEqual(f.writes, []); assert.equal(f.approvals, 0);
});

test('unknown duty ids and missing routes refuse before approval or persistence', async t => {
  const f = await fixture(t);
  const cases = [
    [[{ name: 'frontend', ...route, role: 'no-such-duty' }], 'UNKNOWN_ROLE_TEMPLATE'],
    [[{ name: 'frontend', ...route, role: 'a'.repeat(33) }], 'INVALID_ROLE_TEMPLATE_ID'],
    [[{ name: 'frontend', provider: 'codeagent', model: 'build-model' }], 'INVALID_MEMBER_ADDITION'],
    [[{ name: 'frontend', model: 'build-model', reasoning_effort: 'max' }], 'INVALID_MEMBER_ADDITION'],
    [[{ name: 'implementer', role: 'no-such-duty' }], 'UNKNOWN_ROLE_TEMPLATE'],
    [[{ name: 'lead', ...route }], 'INVALID_ROLE_EDITS'],
    [[{ name: 'Frontend', ...route }], 'INVALID_ROLE_EDITS'],
  ];
  for (const [members, code] of cases) {
    const result = await f.invoke({ action: 'preview', expectedRevision: 3, members });
    assert.equal(result.ok, false, JSON.stringify(members));
    assert.equal(result.code, code, members[0].name);
  }
  assert.deepEqual(f.metadata, []); assert.deepEqual(f.writes, []); assert.equal(f.approvals, 0);
});

test('a role fills only non-route defaults for a new member and explicit edits win', async t => {
  const f = await fixture(t);
  const members = [{ name: 'frontend', ...route, role: 'implementer',
    persona_prompt: 'Explicit persona wins.' }];
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members });
  assert.equal(preview.ok, true);
  const frontend = preview.template.members[2];
  assert.equal(frontend.persona_prompt, 'Explicit persona wins.');
  assert.equal(frontend.description, implementerTemplate.description);
  assert.equal(frontend.prompt, implementerTemplate.prompt);
  // implementer suggestion intersected with this fixture's root catalog:
  // apply_patch and pwsh are suggested but unregistered here.
  assert.deepEqual(frontend.native_tool_allowlist,
    ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'write', 'send_message', 'team_task_get', 'team_task_update']);
  assert.equal(frontend.role, 'implementer');
  const explicit = await f.invoke({ action: 'preview', expectedRevision: 3,
    members: [{ name: 'frontend', ...route, role: 'implementer', description: 'Own duty' }] });
  assert.equal(explicit.template.members[2].description, 'Own duty');
});

test('retagging an existing member with a role never rewrites its configured fields', async t => {
  const f = await fixture(t);
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3,
    members: [{ name: 'implementer', role: 'reviewer' }] });
  assert.equal(preview.ok, true);
  const implementer = preview.template.members[0];
  assert.equal(implementer.role, 'reviewer');
  for (const key of ['description', 'prompt', 'persona_prompt', 'provider', 'model', 'reasoning_effort', 'native_tool_allowlist', 'agent_preset']) {
    assert.deepEqual(implementer[key], base.members[0][key], key);
  }
  assert.deepEqual(f.metadata, []);
});

test('built-in suggestions intersect the live root catalog; explicit and custom lists stay exact', async t => {
  const f = await fixture(t);
  const suggested = await f.invoke({ action: 'preview', expectedRevision: 3,
    members: [{ name: 'frontend', ...route, role: 'implementer' }] });
  assert.equal(suggested.ok, true);
  const intersected = ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'write', 'send_message', 'team_task_get', 'team_task_update'];
  assert.deepEqual(suggested.template.members[2].native_tool_allowlist, intersected);
  const persisted = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: suggested.fingerprint,
    members: [{ name: 'frontend', ...route, role: 'implementer' }] });
  assert.equal(persisted.persisted, true);
  assert.deepEqual(f.template.members[2].native_tool_allowlist, intersected);
  // An explicit list is never filtered: pwsh is suggested but unregistered here.
  const explicit = await f.invoke({ action: 'preview', expectedRevision: 4,
    members: [{ name: 'shell-user', ...route, role: 'tester', native_tool_allowlist: ['pwsh'] }] });
  assert.equal(explicit.ok, false); assert.equal(explicit.code, 'TEAM_TOOL_UNAVAILABLE');
  // A custom template's list stays exact; adopting or saving it refuses on missing tools.
  const customs = [{ ...customRecord('pwsh-only'), native_tool_allowlist: ['pwsh'] }];
  const adopted = await f.invoke({ action: 'preview', expectedRevision: 4, customTemplates: customs,
    members: [{ name: 'custom-user', ...route, role: 'pwsh-only' }] });
  assert.equal(adopted.ok, false); assert.equal(adopted.code, 'TEAM_TOOL_UNAVAILABLE');
  assert.equal(f.writes.length, 1);
});

test('custom duty templates persist in the same CAS write and survive a cold re-read', async t => {
  const f = await fixture(t);
  const customs = [customRecord('platform-builder')];
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, customTemplates: customs });
  assert.equal(preview.ok, true); assert.deepEqual(preview.customTemplates, customs);
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, customTemplates: customs });
  assert.equal(result.persisted, true); assert.equal(f.approvals, 1);
  assert.deepEqual(f.customs, customs);
  assert.deepEqual(f.writes[0].customRoleTemplates, customs);
  const cold = await fixture(t, { rowCustoms: f.customs });
  const listed = await cold.invoke({ action: 'roles' });
  const custom = listed.templates.filter(row => row.source === 'custom');
  assert.deepEqual(custom.map(row => row.id), ['platform-builder']);
  assert.deepEqual(custom[0].native_tool_allowlist, customs[0].native_tool_allowlist);
  const inspect = await cold.invoke({ action: 'inspect' });
  assert.equal(inspect.fingerprint, preview.fingerprint);
});

test('a member may adopt a custom template submitted in the same preview', async t => {
  const f = await fixture(t);
  const customs = [customRecord('platform-builder')];
  const members = [{ name: 'platform', ...route, role: 'platform-builder', native_tool_allowlist: ['team_task_get', 'grep'] }];
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members, customTemplates: customs });
  assert.equal(preview.ok, true);
  assert.equal(preview.template.members[2].description, 'Custom platform-builder');
  assert.deepEqual(preview.template.members[2].native_tool_allowlist, ['team_task_get', 'grep']);
  const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint,
    members, customTemplates: customs });
  assert.equal(result.persisted, true);
  const later = await f.invoke({ action: 'preview', expectedRevision: 4,
    members: [{ name: 'platform-two', ...route, role: 'platform-builder' }] });
  assert.equal(later.ok, true);
});

test('custom template shape failures, duplicates and built-in shadowing are refused', async t => {
  const f = await fixture(t);
  const cases = [
    [[{ ...customRecord('dup'), id: 'x' }, { ...customRecord('dup'), id: 'x' }], 'DUPLICATE_ROLE_TEMPLATE_ID'],
    [[{ ...customRecord('implementer') }], 'RESERVED_ROLE_TEMPLATE_ID'],
    [[{ id: 'bad-record', description: 'Missing fields' }], 'INVALID_ROLE_TEMPLATE_PERSONA'],
    [[{ ...customRecord('too-long'), description: 'a'.repeat(201) }], 'INVALID_ROLE_TEMPLATE_DESCRIPTION'],
    [[{ ...customRecord('blank-persona'), persona_prompt: '   ' }], 'INVALID_ROLE_TEMPLATE_PERSONA'],
    [[{ ...customRecord('bad-tools'), native_tool_allowlist: ['spawn_agent'] }], 'UNSUPPORTED_ROLE_TEMPLATE_TOOL'],
    [[{ ...customRecord('lead') }], 'CUSTOM_TEMPLATE_ID_RESERVED'],
  ];
  for (const [customs, code] of cases) {
    const result = await f.invoke({ action: 'preview', expectedRevision: 3, customTemplates: customs });
    assert.equal(result.ok, false, JSON.stringify(customs.map(item => item.id)));
    assert.equal(result.code, code, customs[0].id);
  }
  assert.deepEqual(f.writes, []); assert.equal(f.approvals, 0);
});

test('the configure fingerprint covers both the member template and the custom catalog', async t => {
  const f = await fixture(t);
  const members = [{ name: 'implementer', persona_prompt: 'Changed.' }];
  const memberOnly = await f.invoke({ action: 'preview', expectedRevision: 3, members });
  const both = await f.invoke({ action: 'preview', expectedRevision: 3, members, customTemplates: [customRecord('platform-builder')] });
  assert.notEqual(memberOnly.fingerprint, both.fingerprint);
  const stale = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: memberOnly.fingerprint,
    members, customTemplates: [customRecord('platform-builder')] });
  assert.equal(stale.ok, false); assert.equal(stale.code, 'CONFIGURATION_PREVIEW_CHANGED');
  assert.deepEqual(f.writes, []);
  const applied = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: both.fingerprint,
    members, customTemplates: [customRecord('platform-builder')] });
  assert.equal(applied.persisted, true);
  assert.deepEqual(f.customs.map(item => item.id), ['platform-builder']);
});

test('concurrent revision change, approval cancellation and tool revocation never persist member additions', async t => {
  for (const option of ['concurrent', 'cancelled', 'removeOnApproval']) {
    const f = await fixture(t, { [option]: option === 'removeOnApproval' ? 'read' : true });
    const members = [{ name: 'frontend', ...route, role: 'implementer', native_tool_allowlist: ['team_task_get', 'read'] }];
    const preview = await f.invoke({ action: 'preview', expectedRevision: 3, members });
    assert.equal(preview.ok, true, option);
    const result = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint, members });
    assert.equal(result.ok, false, option); assert.deepEqual(f.writes, [], option);
    assert.equal(f.template.members.length, 2, option);
  }
});

test('operator-configured seeds serve as defaults until the settings row persists its own catalog', async t => {
  const seeds = [customRecord('seed-duty')];
  const f = await fixture(t, { defaultCustoms: seeds });
  const listed = await f.invoke({ action: 'roles' });
  assert.deepEqual(listed.templates.filter(row => row.source === 'custom').map(row => row.id), ['seed-duty']);
  const preview = await f.invoke({ action: 'preview', expectedRevision: 3,
    members: [{ name: 'seeded', ...route, role: 'seed-duty' }] });
  assert.equal(preview.ok, true);
  assert.equal(preview.template.members[2].description, 'Custom seed-duty');
  // Adopting a seeded duty persists the seed itself into the settings row.
  const adopted = await f.invoke({ action: 'apply', expectedRevision: 3, expectedFingerprint: preview.fingerprint,
    members: [{ name: 'seeded', ...route, role: 'seed-duty' }] });
  assert.equal(adopted.persisted, true); assert.deepEqual(f.customs, seeds);
  // Clearing the catalog retags the member instead of leaving a dangling duty id.
  const cleared = await f.invoke({ action: 'preview', expectedRevision: 4, customTemplates: [],
    members: [{ name: 'seeded', role: 'implementer' }] });
  assert.equal((await f.invoke({ action: 'apply', expectedRevision: 4, expectedFingerprint: cleared.fingerprint,
    customTemplates: [], members: [{ name: 'seeded', role: 'implementer' }] })).persisted, true);
  assert.deepEqual(f.customs, []);
  const after = await f.invoke({ action: 'roles' });
  assert.deepEqual(after.templates.filter(row => row.source === 'custom'), []);
  assert.equal(f.template.members.find(row => row.name === 'seeded').role, 'implementer');
});
