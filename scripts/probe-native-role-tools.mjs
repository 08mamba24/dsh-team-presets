/** Native registry/executor and skill lifecycle probes; no Host daemon or model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probeNativeRoleTools({ runtime, plugin, workspace }) {
  const require = createRequire(join(runtime, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { ToolsService, defineTool }, { NativeToolExecutor }, { createScope }, { SkillRegistry },
    { AgentRegistry }, { SessionProjectionRegistry }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
    load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-skill'), load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-session-projection'),
  ]);
  const rolePlugin = await import(pathToFileURL(join(plugin, 'launcher-role.js')).href);
  const { roleToolCatalog, captureRoleToolAuthority } = await import(pathToFileURL(join(plugin, 'src', 'role-tools.js')).href);
  const { applyTeamConfigurator } = await import(pathToFileURL(join(plugin, 'src', 'team-configure.js')).href);
  const ctx = new Context(), checks = [];
  const scopes = [], agentDisposers = [], presetContexts = new WeakMap();
  let describeSettings = () => [];
  ctx.provide('settings', {
    describe: (...args) => describeSettings(...args),
    update() { throw new Error('probe must not persist settings'); },
  });
  ctx.provide('systemPrompt', { tools() { return () => {}; }, section() { return () => {}; } });
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
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
  const root = { id: 'session-native-probe-root', session: { id: 'session-native-probe-root', header: {} } };
  const parent = createScope(ctx, root); scopes.push(parent); root.ctx = parent.ctx;
  agentDisposers.push(await ctx.agents.register(root));
  const modelSelection = { provider: 'probe', model: 'no-model-is-called' };
  const signal = new AbortController().signal;
  let sequence = 0;
  async function child(role, tools) {
    // Native standing Presets have their own generation scope, rather than
    // inheriting an unrelated root Agent's scoped registrations.
    const presetKey = {}, preset = createScope(ctx, presetKey); scopes.push(preset);
    await preset.ctx.plugin(rolePlugin, {
      ownedSessionId: root.id, roleName: role, personaPrompt: 'Native tool probe.', tools,
    });
    const id = `session-native-probe-${role}`;
    const agent = { id, session: { id, header: { origin: 'subagent', parentSession: root.id } } };
    const scope = createScope(ctx, agent, { parent: presetKey }); scopes.push(scope); agent.ctx = scope.ctx;
    presetContexts.set(agent, preset.ctx);
    agentDisposers.push(await ctx.agents.register(agent));
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
    assert.equal((await call(writer, 'write', { content: 'must not run' })).isError, true);
    assert.equal(bodyWrites, 1);
    rootRestriction();
    const restrict = presetContexts.get(writer).tools.restrict({ deny: ['write'] });
    assert.equal((await call(writer, 'write', { content: 'must not run' })).isError, true);
    assert.equal(bodyWrites, 1); restrict();
    checks.push('native-preset-mask-intersection-and-root-catalog-restriction');

    const authority = captureRoleToolAuthority(ctx, root, [['write']]);
    const toolSet = await ctx.tools.resolve({ agent: writer, modelSelection, signal });
    const release = root.ctx.tools.restrict({ deny: ['write'] });
    assert.throws(() => authority.assertAvailable(), { code: 'TEAM_TOOL_UNAVAILABLE' });
    const afterAdmission = await ctx.tools.execute({ agent: writer, signal, toolSet,
      calls: [{ type: 'tool-call', id: 'root-revoked-after-admission', name: 'write',
        arguments: JSON.stringify({ content: 'must not run' }) }] });
    assert.equal(afterAdmission.results[0].result.isError, true); assert.equal(bodyWrites, 1);
    release(); toolSet.dispose();
    checks.push('native-independent-preset-rechecks-root-authority-after-step-admission');

    let approvalCalls = 0, liftApprovalRestriction;
    ctx.provide('approval', { async request() {
      approvalCalls++; await new Promise(resolve => setImmediate(resolve));
      liftApprovalRestriction = root.ctx.tools.restrict({ deny: ['write'] });
      return 'allowed-once';
    } });
    const ask = writer.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'write' ? { kind: 'ask' } : next());
    const afterApproval = await call(writer, 'write', { content: 'must not run' });
    assert.equal(approvalCalls, 1); assert.equal(afterApproval.isError, true); assert.equal(bodyWrites, 1);
    liftApprovalRestriction(); ask();
    checks.push('native-approval-pipeline-rechecks-root-revocation-after-isolated-allow-once-answer');

    const base = JSON.parse(await readFile(join(plugin, 'examples', 'team-template.json'), 'utf8'));
    describeSettings = () => [{ ns: 'dsh-native-current-team', revision: 1, value: { template: base, replacementRecords: {} } }];
    ctx.provide('llm', { listProviders: () => [] });
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) });
    const old = ctx.plugin({ name: 'previous-skill-probe', apply(inner) {
      inner.skills.register({ name: 'dsh-team-configure', source: 'runtime', description: 'Previous bundled skill', content: 'PREVIOUS_SKILL_BODY' });
    } });
    await old;
    assert.equal((await ctx.skills.get('dsh-team-configure', { scope: root })).content, 'PREVIOUS_SKILL_BODY');
    await old.dispose();
    assert.equal(await ctx.skills.get('dsh-team-configure', { scope: root }), undefined);
    const current = ctx.plugin({ name: 'current-skill-probe', inject: ['sessionProjections'], async apply(inner) {
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
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(preview.template.members[1].native_tool_allowlist, ['read']);
    assert.equal(preview.persisted, false); assert.deepEqual(preview.metadataValidated, []);
    checks.push('native-configuration-array-schema-and-shared-tool-catalog');
    await current.dispose();
    assert.equal(await ctx.skills.get('dsh-team-configure', { scope: root }), undefined);
    assert.equal(ctx.tools.get('dsh_team_configure', root), undefined);
    const stale = JSON.parse(await captured.execute({ action: 'inspect' }, { agent: root, callId: 'stale', signal }));
    assert.equal(stale.code, 'UNLOADING');
    checks.push('native-plugin-disposal-removes-skill-and-editor-and-closes-captured-handler');
    checks.push(...await probeWebPresetTools({ load, plugin, workspace }));
    return { passed: true, checks, boundary: 'Physical native registry/executor/Scope/SkillRegistry; isolated identities and temporary files. Web-style standard Preset uses actual native file/search/shell modules, LocalFileSystem and LocalSubprocessRuntime; file and foreground shell bodies execute. Search schemas are checked without a search process. No Host daemon, provider, user profile or persistent Session. Local probe backends do not confine; OS sandbox backends and paid model execution are not claimed.' };
  } finally {
    for (const dispose of agentDisposers.reverse()) await dispose();
    for (const scope of scopes.reverse()) await scope.dispose();
    await ctx.fiber.dispose();
  }
}

/** Reproduce the official Web composition: work tools belong to a standard
 * Preset, not the shared registry; role Presets remain independent. */
async function probeWebPresetTools({ load, plugin, workspace }) {
  const [{ Context }, { ToolsService }, { NativeToolExecutor }, { createScope, scopeOf },
    { SkillRegistry }, { LocalFileSystem }, { LocalSubprocessRuntime }, fsTools, searchTools,
    shellTools, shellBackend, { ShellEnvRegistry }, { approveEscalation }, { defineTool },
    { AgentRegistry }, { SessionProjectionRegistry }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
    load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-skill'), load('@deepseek-ai/dsh-fs-local'),
    load('@deepseek-ai/dsh-subprocess-local'), load('@deepseek-ai/dsh-tool-fs'), load('@deepseek-ai/dsh-tool-fs-search'),
    load(process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash'),
    load(process.platform === 'win32' ? '@deepseek-ai/dsh-pwsh-local' : '@deepseek-ai/dsh-bash-local'),
    load('@deepseek-ai/dsh-shell-env'),
    load('@deepseek-ai/dsh-sandbox'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-session-projection'),
  ]);
  const { roleToolCatalog, defaultWorkTemplate } = await import(pathToFileURL(join(plugin, 'src/role-tools.js')).href);
  const rolePlugin = await import(pathToFileURL(join(plugin, 'launcher-role.js')).href);
  const { applyTeamConfigurator } = await import(pathToFileURL(join(plugin, 'src/team-configure.js')).href);
  const ctx = new Context(), scopes = [], agentDisposers = [], checks = [], presetContexts = new WeakMap();
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  let revision = 1, value = { replacementRecords: {} };
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-native-current-team', revision, value }],
    update(ns, next, expected) { assert.equal(ns, 'dsh-native-current-team'); assert.equal(expected, revision);
      value = { ...value, ...structuredClone(next) }; revision++; } });
  const root = { id: 'session-web-probe-root', session: { id: 'session-web-probe-root', header: { cwd: workspace } } };
  ctx.provide('systemPrompt', { tools() { return () => {}; }, section() { return () => {}; }, getSectionOrder() { return 1; } });
  ctx.provide('workingDirectory', { get: () => workspace,
    async ensure(_agent, signal) { signal?.throwIfAborted(); return workspace; } });
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  new ToolsService(ctx); new SkillRegistry(ctx); ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 });
  new LocalSubprocessRuntime(ctx);
  new ShellEnvRegistry(ctx, { dshHome: workspace });
  const variable = value => ({ get: () => value });
  const shellConfig = Object.fromEntries(Object.entries({ cwd: workspace, timeoutMs: 5000, maxTimeoutMs: 5000,
    maxOutputBytes: 64000, maxSpillBytes: 1048576, graceMs: 100, ...shell === 'pwsh' ? { pwshPath: undefined } : {},
  }).map(([key, value]) => [key, variable(value)]));
  new shellBackend.default(ctx, shellConfig);
  const standardKey = {}, standard = createScope(ctx, standardKey); scopes.push(standard);
  const rootScope = createScope(ctx, root, { parent: standardKey }); scopes.push(rootScope); root.ctx = rootScope.ctx;
  agentDisposers.push(await ctx.agents.register(root));
  try {
    fsTools.apply(standard.ctx, fsTools.Config({ readImage: false, applyPatch: false }));
    searchTools.apply(standard.ctx, searchTools.Config({ sampleOverCapGlobResults: false }));
    shellTools.apply(standard.ctx, { enableRunInBackground: false });
    const nativeNames = ['edit', 'glob', 'grep', 'read', 'write', shell].sort();
    assert.deepEqual(ctx.tools.definitions().map(tool => tool.name), []);
    assert.deepEqual(ctx.tools.definitions(root).map(tool => tool.name).sort(), nativeNames);
    const bundled = JSON.parse(await readFile(join(plugin, 'examples/team-template.json'), 'utf8'));
    const defaults = defaultWorkTemplate(ctx, root, bundled);
    for (const member of defaults.members) for (const name of nativeNames) assert.ok(member.native_tool_allowlist.includes(name));
    assert.ok(roleToolCatalog(ctx, root).some(tool => tool.name === 'read'));
    checks.push('native-web-preset-local-work-tools-appear-in-catalog-and-unsaved-defaults');

    ctx.provide('llm', { listProviders: () => [] });
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) });
    await ctx.plugin({ name: 'web-configuration-probe', inject: ['sessionProjections'], apply(inner) {
      return applyTeamConfigurator(inner, { assertRoot() {}, defaultTemplate: () => defaults, hasBinding: () => false },
        { defineTool, approveEscalation });
    } });
    const editor = ctx.tools.get('dsh_team_configure', root), signal = new AbortController().signal;
    const members = [{ name: 'implementer', native_tool_allowlist: ['read', 'write', shell] },
      { name: 'reviewer', native_tool_allowlist: ['read'] }];
    const edit = { action: 'preview', expectedRevision: revision, members };
    const preview = JSON.parse(await editor.execute(edit, { agent: root, callId: 'web-preview', signal }));
    assert.equal(preview.ok, true);
    const saved = JSON.parse(await editor.execute({ ...edit, action: 'apply', expectedFingerprint: preview.fingerprint },
      { agent: root, callId: 'web-apply', signal }));
    assert.equal(saved.persisted, true); assert.deepEqual(value.template.members[0].native_tool_allowlist, ['read', 'write', shell]);
    checks.push('native-web-preset-local-role-lists-preview-and-save-with-native-approval-rules');

    async function child(role, tools) {
      const key = {}, preset = createScope(ctx, key); scopes.push(preset);
      await preset.ctx.plugin(rolePlugin, {
        ownedSessionId: root.id, roleName: role, personaPrompt: 'Web tool probe.', tools,
      });
      const id = `session-web-probe-${role}`;
      const agent = { id, session: { id,
        header: { origin: 'subagent', parentSession: root.id, cwd: workspace } } };
      const scope = createScope(ctx, agent, { parent: key }); scopes.push(scope); agent.ctx = scope.ctx;
      presetContexts.set(agent, preset.ctx);
      agentDisposers.push(await ctx.agents.register(agent));
      assert.deepEqual(ctx.tools.schemas(agent).map(row => row.name).sort(), [...tools].sort());
      return agent;
    }
    const writer = await child('implementer', members[0].native_tool_allowlist);
    const reader = await child('reviewer', members[1].native_tool_allowlist);
    assert.equal(ctx.agents.get(root.id), root);
    assert.equal(ctx.agents.get(writer.id), writer);
    assert.ok(Array.isArray(root.ctx.settings.describe({ redactSecrets: true })));
    let sequence = 0;
    async function call(agent, name, args) {
      const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'probe', model: 'no-model' } });
      try { return (await ctx.tools.execute({ agent, signal, toolSet,
        calls: [{ type: 'tool-call', id: `web-probe-${++sequence}`, name, arguments: JSON.stringify(args) }] })).results[0].result; }
      finally { toolSet.dispose(); }
    }
    const filename = join(workspace, 'native-web-preset.txt');
    const written = await call(writer, 'write', { file_path: filename, content: 'native Web Preset bridge' });
    assert.notEqual(written.isError, true, JSON.stringify(written));
    assert.equal(await readFile(filename, 'utf8'), 'native Web Preset bridge');
    const read = await call(reader, 'read', { file_path: filename });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.ok(JSON.stringify(read.content).includes('native Web Preset bridge'));
    const command = shell === 'pwsh' ? 'Write-Output "native-role-shell-ok"' : 'printf native-role-shell-ok';
    const ran = await call(writer, shell, { description: 'Print the isolated acceptance marker.', command });
    assert.notEqual(ran.isError, true, JSON.stringify(ran));
    assert.ok(JSON.stringify(ran.content).includes('native-role-shell-ok'));
    checks.push('native-web-preset-role-schemas-and-real-file-and-foreground-shell-bodies');

    const resumed = { id: 'session-web-probe-recomposed', session: { id: 'session-web-probe-recomposed',
      header: { origin: 'subagent', parentSession: root.id, cwd: workspace } } };
    const resumedScope = createScope(ctx, resumed, { parent: scopeOf(presetContexts.get(writer)) });
    scopes.push(resumedScope); resumed.ctx = resumedScope.ctx;
    agentDisposers.push(await ctx.agents.register(resumed));
    assert.deepEqual(ctx.tools.schemas(resumed).map(row => row.name).sort(), [...members[0].native_tool_allowlist].sort());
    assert.notEqual((await call(resumed, 'read', { file_path: filename })).isError, true);
    checks.push('native-web-role-preset-recomposition-reuses-exact-delegated-definitions');

    assert.equal((await call(reader, 'write', { file_path: filename, content: 'must not run' })).isError, true);
    const revoke = root.ctx.tools.restrict({ deny: ['write'] });
    assert.equal((await call(writer, 'write', { file_path: filename, content: 'must not run' })).isError, true);
    assert.equal(await readFile(filename, 'utf8'), 'native Web Preset bridge'); revoke();
    checks.push('native-web-preset-root-revocation-and-unselected-role-tools-refuse-before-body');

    for (const context of [writer.ctx, presetContexts.get(writer)]) {
      const lift = context.tools.restrict({ allow: [] });
      const masked = await call(writer, 'write', { file_path: filename, content: 'must not run' });
      assert.equal(masked.isError, true);
      assert.equal(await readFile(filename, 'utf8'), 'native Web Preset bridge'); lift();
    }
    checks.push('native-web-preset-work-tools-obey-child-and-preset-deny-all-intersection');
    for (const context of [writer.ctx, presetContexts.get(writer)]) {
      let lift, answers = 0;
      const approval = ctx.plugin({ name: 'isolated-mask-approval', apply(inner) {
        inner.provide('approval', { async request() {
          answers++; await new Promise(resolve => setImmediate(resolve));
          lift = context.tools.restrict({ allow: [] }); return 'allowed-once';
        } });
      } });
      await approval;
      const ask = writer.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'write' ? { kind: 'ask' } : next());
      const masked = await call(writer, 'write', { file_path: filename, content: 'must not run' });
      assert.equal(answers, 1); assert.equal(masked.isError, true);
      assert.equal(await readFile(filename, 'utf8'), 'native Web Preset bridge');
      lift(); ask(); await approval.dispose();
    }
    checks.push('native-web-preset-work-tools-obey-child-and-preset-masks-added-during-approval');
    return checks;
  } finally {
    for (const dispose of agentDisposers.reverse()) await dispose();
    for (const scope of scopes.reverse()) await scope.dispose();
    await ctx.fiber.dispose();
  }
}
