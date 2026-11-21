/** Native registry/executor and skill lifecycle probes; no Host daemon or model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probeNativeRoleTools({ runtime, plugin, workspace }) {
  const require = createRequire(join(runtime, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { ToolsService, defineTool }, { NativeToolExecutor }, { createScope, scopeTarget }, { SkillRegistry }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
    load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-skill'),
  ]);
  const { apply: applyRole } = await import(pathToFileURL(join(plugin, 'launcher-role.js')).href);
  const { roleToolCatalog } = await import(pathToFileURL(join(plugin, 'src', 'role-tools.js')).href);
  const { applyTeamConfigurator } = await import(pathToFileURL(join(plugin, 'src', 'team-configure.js')).href);
  const ctx = new Context(), checks = [];
  const scopes = [], presetContexts = new WeakMap();
  ctx.provide('systemPrompt', { tools() { return () => {}; }, section() { return () => {}; } });
  new ToolsService(ctx); new SkillRegistry(ctx);
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  let bodyWrites = 0;
  const allowed = join(workspace, 'native-role-tool-probe.txt');
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  ctx.tools.register(defineTool({ name: 'read', description: 'Read the isolated probe file.',
    parameters: {}, output, execute: () => readFile(allowed, 'utf8') }));
  ctx.tools.register(defineTool({ name: 'write', description: 'Write the isolated probe file.',
    parameters: { content: { type: 'string', required: true } }, output,
    async execute(args) { bodyWrites++; await writeFile(allowed, args.content); return args.content; } }));
  for (const name of ['team_task_get', 'team_task_update', 'spawn_agent']) {
    ctx.tools.register(defineTool({ name, description: `Catalog-only probe: ${name}`, parameters: {}, output,
      execute() { throw new Error('catalog-only capability must not execute'); } }));
  }
  const root = { id: 'native-probe-root', session: { header: {} } };
  const parent = createScope(ctx, root); scopes.push(parent); root.ctx = parent.ctx;
  const modelSelection = { provider: 'probe', model: 'no-model-is-called' };
  const signal = new AbortController().signal;
  let sequence = 0;
  async function child(role, tools) {
    // Native standing Presets have their own generation scope, rather than
    // inheriting an unrelated root Agent's scoped registrations.
    const presetKey = {}, preset = createScope(ctx, presetKey); scopes.push(preset);
    await applyRole(preset.ctx, { ownedSessionId: root.id, roleName: role, personaPrompt: 'Native tool probe.', tools });
    const agent = { id: `native-probe-${role}`, session: { header: { origin: 'subagent', parentSession: root.id } } };
    const scope = createScope(ctx, agent, { parent: presetKey }); scopes.push(scope); agent.ctx = scope.ctx;
    presetContexts.set(agent, preset.ctx);
    await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent });
    return agent;
  }
  async function call(agent, name, args = {}) {
    const toolSet = await ctx.tools.resolve({ agent, modelSelection, signal });
    try {
      const batch = await ctx.tools.execute({ agent, signal, toolSet,
        calls: [{ type: 'tool-call', id: `probe-${++sequence}`, name, arguments: JSON.stringify(args) }] });
      return batch.results[0].result;
    } finally { toolSet.dispose(); }
  }
  try {
    const writer = await child('implementer', ['read', 'write']);
    const reader = await child('reviewer', ['read']);
    assert.deepEqual(ctx.tools.schemas(writer).map(row => row.name).sort(), ['read', 'write']);
    assert.deepEqual(ctx.tools.schemas(reader).map(row => row.name), ['read']);
    assert.ok(!(await call(writer, 'write', { content: 'native executor wrote this' })).isError);
    assert.equal(await readFile(allowed, 'utf8'), 'native executor wrote this');
    const read = await call(reader, 'read');
    assert.ok(!read.isError && JSON.stringify(read.content).includes('native executor wrote this'));
    checks.push('native-scoped-role-tools-execute-real-temporary-file-io');
    assert.equal((await call(reader, 'write', { content: 'must not run' })).isError, true);
    assert.equal(bodyWrites, 1);
    checks.push('unselected-native-tool-never-reaches-body');
    const deny = writer.ctx.tools.guard(exec => exec.name === 'write' ? { reason: 'native permission probe refusal' } : undefined);
    assert.equal((await call(writer, 'write', { content: 'must not run' })).isError, true);
    assert.equal(bodyWrites, 1);
    assert.equal(await readFile(allowed, 'utf8'), 'native executor wrote this');
    deny(); checks.push('native-final-guard-refusal-is-preserved');
    const rootRestriction = root.ctx.tools.restrict({ deny: ['write'] });
    assert.equal(roleToolCatalog(ctx, root).some(tool => tool.name === 'write'), false);
    rootRestriction();
    const restrict = presetContexts.get(writer).tools.restrict({ deny: ['write'] });
    assert.equal((await call(writer, 'write', { content: 'must not run' })).isError, true);
    assert.equal(bodyWrites, 1); restrict();
    checks.push('native-preset-mask-intersection-and-root-catalog-restriction');

    const base = JSON.parse(await readFile(join(plugin, 'examples', 'team-template.json'), 'utf8'));
    ctx.provide('settings', { describe: () => [{ ns: 'dsh-native-current-team', revision: 1, value: { template: base } }],
      update() { throw new Error('probe must not persist settings'); } });
    ctx.provide('llm', { listProviders: () => [] });
    ctx.provide('sessionProjections', { stateOf: () => [] });
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) });
    const old = ctx.plugin({ name: 'previous-skill-probe', apply(inner) {
      inner.skills.register({ name: 'dsh-team-configure', source: 'runtime', description: 'Previous bundled skill', content: 'PREVIOUS_SKILL_BODY' });
    } });
    await old;
    assert.equal((await ctx.skills.get('dsh-team-configure', { scope: root })).content, 'PREVIOUS_SKILL_BODY');
    await old.dispose();
    assert.equal(await ctx.skills.get('dsh-team-configure', { scope: root }), undefined);
    const current = ctx.plugin({ name: 'current-skill-probe', async apply(inner) {
      await applyTeamConfigurator(inner, { assertRoot: () => {}, defaultTemplate: () => base, hasBinding: () => false },
        { defineTool, approveEscalation() { throw new Error('probe must not request approval'); } });
    } });
    await current;
    const loaded = await ctx.skills.get('dsh-team-configure', { scope: root });
    assert.ok(loaded.content.includes('native_tool_allowlist'));
    assert.equal((await ctx.skills.list({ scope: root })).filter(skill => skill.name === 'dsh-team-configure').length, 1);
    checks.push('native-skill-cache-replaces-unloaded-old-body-with-bundled-new-body');
    const captured = ctx.tools.get('dsh_team_configure', root);
    const exec = { agent: root, callId: 'configuration-probe', signal };
    const catalog = JSON.parse(await captured.execute({ action: 'tools' }, exec));
    assert.ok(catalog.ok && catalog.tools.some(tool => tool.name === 'read'));
    assert.equal(catalog.tools.some(tool => ['spawn_agent', 'dsh_team_configure'].includes(tool.name)), false);
    const preview = JSON.parse(await captured.execute({ action: 'preview', expectedRevision: 1,
      members: [{ name: 'reviewer', native_tool_allowlist: ['read'] }] }, exec));
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.template.members[1].native_tool_allowlist, ['read']);
    assert.equal(preview.persisted, false); assert.deepEqual(preview.metadataValidated, []);
    checks.push('native-configuration-array-schema-and-shared-tool-catalog');
    await current.dispose();
    assert.equal(await ctx.skills.get('dsh-team-configure', { scope: root }), undefined);
    assert.equal(ctx.tools.get('dsh_team_configure', root), undefined);
    const stale = JSON.parse(await captured.execute({ action: 'inspect' }, { agent: root, callId: 'stale', signal }));
    assert.equal(stale.code, 'UNLOADING');
    checks.push('native-plugin-disposal-removes-skill-and-editor-and-closes-captured-handler');
    return { passed: true, checks, boundary: 'Physical native ToolsService/NativeToolExecutor/Scope/SkillRegistry; isolated context and role identities; file tool handlers use one real temporary file. No Host daemon, provider, user profile or persistent Session. Native final-guard denial is tested; OS sandbox backends and paid model execution are not claimed.' };
  } finally {
    for (const scope of scopes.reverse()) await scope.dispose();
    await ctx.fiber.dispose();
  }
}
