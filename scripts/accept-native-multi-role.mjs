/** Official Web profile multi-member acceptance with a local scripted provider and temporary data. */
import assert from 'node:assert/strict';
import { nativeAgentRows, setNativeModelRoutes } from './native-host-contract.mjs';
import { seedNativeLegacy } from './native-legacy-seed.mjs';
import { describeNativeError } from './native-error.mjs';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plugin = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtime = resolve(process.argv[2] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh');
const receipt = resolve(process.argv[4] ?? 'native-multi-role.json');
const sourceHead = process.argv[5] ?? 'working-tree';
const legacyPlugin = process.argv[6] && resolve(process.argv[6]);
const unchangedLegacyDefaults = process.argv[7] === 'unchanged';
const legacyHostExecutable = process.argv[8] && resolve(process.argv[8]);
const seedOnly = process.argv.includes('--seed-legacy');

// Profile boot resolves home paths and environment-backed providers during
// import. Relaunch before importing runtime modules, with only laboratory
// paths and OS essentials; the operator's profile and credentials are absent.
if (process.env.DSH_MULTI_ROLE_ACCEPT_LAB === undefined) {
  const lab = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-multi-role-')));
  let code = 1;
  let result = { sourceHead, runtime, isolatedDataRemoved: false, passed: false, checks: [], errors: [] };
  try {
    for (const name of ['home', 'harness', 'agents', 'workspace', 'tmp']) await mkdir(join(lab, name));
    const resources = dirname(dirname(runtime));
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    assert.ok(process.platform !== 'win32' || system, 'Windows SystemRoot is required');
    const environment = {
      ...(system ? { SystemRoot: system, WINDIR: system, ComSpec: join(system, 'System32', 'cmd.exe') } : {}),
      PATH: process.platform === 'win32'
        ? [join(resources, 'runtime', 'bin'), join(system, 'System32'), system].join(';')
        : '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(lab, 'home'), USERPROFILE: join(lab, 'home'),
      APPDATA: join(lab, 'home', 'AppData', 'Roaming'), LOCALAPPDATA: join(lab, 'home', 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(lab, 'home', 'config'), XDG_CACHE_HOME: join(lab, 'home', 'cache'),
      XDG_DATA_HOME: join(lab, 'home', 'data'), XDG_STATE_HOME: join(lab, 'home', 'state'),
      TMPDIR: join(lab, 'tmp'), TEMP: join(lab, 'tmp'), TMP: join(lab, 'tmp'),
      DSH_HOME: join(lab, 'harness'), DSH_AGENTS_HOME: join(lab, 'agents'), DSH_TELEMETRY_DISABLED: '1',
      DSH_PRIMARY_RUNTIME: join(resources, 'runtime', 'primary-runtime'),
      ELECTRON_RUN_AS_NODE: '1', DSH_MULTI_ROLE_ACCEPT_LAB: lab,
    };
    const childReceipt = join(lab, 'native-result.json');
    const args = [runtime, plugin, childReceipt, sourceHead];
    if (legacyPlugin) args.push(legacyPlugin);
    if (legacyPlugin) args.push(unchangedLegacyDefaults ? 'unchanged' : 'changed');
    if (legacyHostExecutable) args.push(legacyHostExecutable);
    const child = spawn(process.execPath, ['--expose-internals', fileURLToPath(import.meta.url), ...args],
      { cwd: join(lab, 'workspace'), env: environment, stdio: 'inherit', windowsHide: true });
    code = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', code => done(code ?? 1));
    });
    result = JSON.parse(await readFile(childReceipt, 'utf8'));
    if (code !== 0) {
      result.passed = false;
      result.errors.push({ message: `Acceptance child exited with code ${code}.` });
    }
  } catch (error) {
    result.passed = false;
    result.errors.push(describeNativeError(error));
  } finally {
    // Windows retains both cwd and native-addon file locks until process exit.
    // This supervisor imported no runtime code and owns the final cleanup and
    // receipt, so a successful child never reports unverified data removal.
    try {
      await rm(lab, { recursive: true, force: true });
      result.isolatedDataRemoved = true;
    } catch (error) {
      result.passed = false;
      result.errors.push(describeNativeError(error));
    }
    await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  process.exit(code === 0 && result.passed && result.isolatedDataRemoved ? 0 : 1);
}
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const [boot, { PROFILE_TEMPLATES }, { runProfile }, { createLaunchEnvironmentSnapshot }, { defineTool }] = await Promise.all([
  load('dsh-app-boot'), load('dsh-official-bundles'), load('dsh/profile-boot'), load('dsh-launch-environment'), load('dsh-tools'),
]);
const fromPlugin = path => import(pathToFileURL(join(plugin, path)).href);
const [{ REPLACEMENT_OWNER }, { pollReplacement, ownSessionEvents }, roleTemplates] = await Promise.all([
  fromPlugin('src/replacement-store.js'), fromPlugin('src/replacement-native.js'), fromPlugin('src/role-templates.js'),
]);
const lab = process.env.DSH_MULTI_ROLE_ACCEPT_LAB, workspace = join(lab, 'workspace');
assert.equal(process.env.DSH_HOME, join(lab, 'harness'));
const packageName = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).name;
const timeoutMs = 10000, signal = AbortSignal.timeout(180000);
const routeOf = name => ({ provider: 'isolated-provider', model: name + '-model', reasoningEffort: 'max' });
const allowedModels = ['root', 'frontend', 'backend', 'tester', 'reviewer', 'researcher', 'designer', 'implementer']
  .map(name => ({ provider: 'isolated-provider', model: name + '-model' }));
const checks = [], errors = [], expectedErrors = [], providerCalls = [], bodies = [], visible = [], starts = [];
const steps = new Map(), behavior = new Map(), approvalRequests = [];
let approvalOutcome = 'allowed-once', forceConfigApproval = false;
let ROOT = 'session-' + randomUUID(), ctx, rootHandle, profileDir, patchPath, records, workTaskId;
let legacySeed;
let scenario = 'launch', profileCase = 'multi-role-current';
const check = (name, evidence = {}) => checks.push({ name, passed: true, ...evidence });
const record = () => records?.()[ROOT];
const operationFor = id => record()?.operations.find(op => op.newChildId === id || 'session-' + op.id.slice(8) === id);
const addedFor = id => record()?.membership?.find(entry => entry.kind === 'add' && entry.childId === id);
const taskSnapshot = () => structuredClone(ctx.agentTeams.listTasks(rootHandle.agent));
function member(name, role, tools) {
  const template = roleTemplates.resolveRoleTemplate(role);
  return { name, role, description: template.description, persona_prompt: template.persona_prompt,
    prompt: 'Confirm readiness with your member name and finish this initial turn.', agent_preset: 'multi-role-' + name,
    provider: 'isolated-provider', model: name + '-model', reasoning_effort: 'max', native_tool_allowlist: tools };
}
const multiTemplate = () => ({ template_schema: 'dsh-team-template/1', version: 1, name: 'multi-member-acceptance', max_members: 8,
  members: [
    member('frontend', 'implementer', ['team_task_get', 'team_task_update', 'send_message', 'multi_frontend_write']),
    member('backend', 'implementer', ['team_task_get', 'team_task_update', 'multi_backend_write']),
    member('tester', 'tester', ['team_task_get']), member('reviewer', 'reviewer', ['team_task_get']),
  ], seed_tasks: [{ key: 'backend-work', subject: 'Backend seed responsibility', description: 'Retain this task until reassigned.', owner: 'backend' }] });
function* toolCall(name, args) {
  const block = { type: 'tool-call', id: 'call-' + randomUUID(), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
}
async function* stream(request) {
  const id = request.sessionId, op = operationFor(id), addition = addedFor(id);
  providerCalls.push({ childId: id, model: request.model, phase: op?.phase ?? addition?.phase ?? scenario });
  if (addition?.name === 'designer' && addition.phase === 'spawning') {
    throw Object.assign(new Error('ISOLATED_ADDITION_FAILURE'), { code: 'ISOLATED_ADDITION_FAILURE' });
  }
  let mode = behavior.get(id);
  if (op) mode = ['activating', 'active'].includes(op.phase) ? 'takeover' : 'standby';
  else if (addition?.phase === 'spawning') mode = 'addition-ready';
  const key = id + ':' + (mode ?? 'idle'), step = (steps.get(key) ?? 0) + 1; steps.set(key, step);
  const agent = ctx.agents.get(id);
  const tools = await agent.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal });
  try { visible.push({ childId: id, phase: mode, tools: [...tools.view(agent).keys()].sort() }); } finally { tools.dispose(); }
  if (mode === 'addition-ready' && step === 1) yield* toolCall('multi_research_write', { text: 'FORBIDDEN before active' });
  if (mode === 'frontend-work' && step === 1) yield* toolCall('multi_frontend_write', { text: 'frontend work' });
  if (mode === 'backend-work' && step === 1) yield* toolCall('multi_backend_write', { text: 'backend work' });
  if (mode === 'research-work' && step === 1) yield* toolCall('multi_research_write', { text: 'research work' });
  if (mode === 'foreign-tool' && step === 1) yield* toolCall('multi_backend_write', { text: 'FORBIDDEN cross-member tool' });
  if (mode === 'standby') {
    if (step <= op.taskRefs.length) yield* toolCall('team_task_get', { task_id: op.taskRefs[step - 1].taskId });
    if (step === op.taskRefs.length + 1) yield* toolCall('send_message', { agent: 'lead', message: JSON.stringify({
      ready: true, operation: op.id, handoff: op.handoffDigest, config: op.configDigest }) });
  }
  if (mode === 'takeover') {
    if (step === 1) yield* toolCall(op.role === 'researcher' ? 'multi_research_write' : 'multi_frontend_write', { text: 'replacement work' });
    if (step === 2 && op.taskRefs.length) yield* toolCall('team_task_get', { task_id: op.taskRefs[0].taskId });
    if (step === 3 && op.taskRefs.length) {
      const task = ctx.agentTeams.getTask(rootHandle.agent, op.taskRefs[0].taskId);
      yield* toolCall('team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'edit', description: task.description + '\nTakeover confirmed.' });
    }
  }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
async function startFixture({ resume = false, legacy = false, initialTemplate } = {}) {
  const selectedPlugin = legacy ? legacyPlugin : plugin;
  const nextProfile = join(lab, 'harness', 'profiles', legacy ? 'multi-role-rc7' : profileCase);
  boot.initProfile(nextProfile, [...PROFILE_TEMPLATES.web.bundles, packageName]);
  await mkdir(join(nextProfile, 'node_modules'), { recursive: true });
  if (resume && profileDir !== nextProfile) await copyFile(patchPath, join(nextProfile, 'cordis.patch.yml'));
  profileDir = nextProfile; patchPath = join(profileDir, 'cordis.patch.yml');
  const link = join(profileDir, 'node_modules', packageName);
  await rm(link, { force: true }); await symlink(selectedPlugin, link, process.platform === 'win32' ? 'junction' : 'dir');
  if (!resume) {
    const config = { mode: 'current-session', timeoutMs, maxStreams: legacy ? { implementer: 1, reviewer: 1 } : { frontend: 1, backend: 1, tester: 1, reviewer: 1 } };
    if (initialTemplate !== undefined) config.template = initialTemplate;
    await writeFile(patchPath, JSON.stringify([{ id: REPLACEMENT_OWNER, config }]));
  }
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.deepEqual(profile.skippedBundles, []);
  ({ ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
    profile: 'multi-role-acceptance', resolvedProfile: { profile, installAnchor }, patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] }));
  const row = () => ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === REPLACEMENT_OWNER);
  assert.ok(row(), 'the real current-entry Schema, including maxStreams dict, must load');
  records = () => row().value.replacementRecords;
  ctx.llm.resolveCallConfig = async config => ({ ...config });
  ctx.llm.prepareCall = async config => ({ config, stream(options) {
    const request = { ...config, ...options };
    return ctx.waterfall(ctx.llm, 'llm/stream', request, () => stream(request));
  } });
  for (const name of ['multi_frontend_write', 'multi_backend_write', 'multi_research_write']) ctx.tools.register(defineTool({
    name, description: 'Isolated observable native tool body.', parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      bodies.push({ tool: name, childId: exec.agent.id, phase: addedFor(exec.agent.id)?.phase ?? operationFor(exec.agent.id)?.phase ?? scenario });
      await writeFile(join(workspace, name + '.txt'), args.text); return args.text;
    },
  }));
  ctx.on('agent/error', ({ error }) => (error.code === 'ISOLATED_ADDITION_FAILURE' ? expectedErrors : errors).push(describeNativeError(error)));
  ctx.on('subagent/start', info => { if (info.parentSessionId === ROOT) {
    const child = ctx.agents.get(info.id); starts.push({ childId: info.id, parent: child?.session.header.parentSession,
      preset: child && ctx.agentPresets.composedPreset(child.ctx), model: child?.model.current(), maxTokens: child?.options.maxTokens });
    assert.equal(ctx.workingDirectory.get(child.session), ctx.workingDirectory.get(rootHandle.agent.session),
      'every initial/add/replacement child must inherit the effective parent workspace');
  } });
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard'); };
  rootHandle = resume ? await ctx.agents.resume({ resumeSessionId: ROOT, agentOptions: routeOf('root'), setup })
    : await ctx.agents.create({ sessionId: ROOT, meta: { cwd: workspace }, agentOptions: routeOf('root'), setup });
  await setNativeModelRoutes(ctx, rootHandle.agent.session, boot.getDshRuntimeVersion(), allowedModels);
  const approval = ctx.get('approval');
  assert.equal(typeof approval?.request, 'function', 'the official profile must compose the native approval service');
  const nativeRequest = approval.request;
  approval.request = async function(input) {
    if (input.toolName !== 'dsh_team_configure') return Reflect.apply(nativeRequest, this, [input]);
    approvalRequests.push({ toolName: input.toolName, sessionId: input.agent.id, outcome: approvalOutcome });
    return approvalOutcome;
  };
  const nativePolicy = ctx.sandboxPolicy.resolve;
  ctx.sandboxPolicy.resolve = function(input) {
    const resolved = Reflect.apply(nativePolicy, this, [input]);
    // Local fixture exercises the real approveEscalation path and a scripted
    // human decision. Production modes and approval code are unchanged.
    return forceConfigApproval && input.session === rootHandle.agent.session ? { ...resolved, mode: 'workspace-write' } : resolved;
  };


}
async function boundedCleanup() {
  let timer;
  try {
    await Promise.race([stopFixture(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('NATIVE_MULTI_ROLE_CLEANUP_TIMEOUT'), { code: 'NATIVE_MULTI_ROLE_CLEANUP_TIMEOUT' })), 15000);
    })]);
  } finally { clearTimeout(timer); }
}
async function stopFixture() {
  if (rootHandle) { await rootHandle.agent.whenIdle(); await rootHandle.dispose(); rootHandle = undefined; }
  if (ctx) { const previous = ctx; ctx = undefined; await previous.fiber.dispose(); }
}
async function command(text) {
  const result = (await ctx.commands.execute(rootHandle.agent, '/dsh-team ' + text, [], signal)).result;
  let value; try { value = JSON.parse(result.text); } catch { value = { text: result.text }; }
  return { ...value, commandKind: result.kind };
}
async function rootTool(name, args) {
  await rootHandle.agent.whenIdle();
  const toolSet = await rootHandle.agent.ctx.tools.resolve({ agent: rootHandle.agent, modelSelection: routeOf('root'), signal });
  try {
    const batch = await rootHandle.agent.runMaintenance(() => rootHandle.agent.ctx.tools.execute({ agent: rootHandle.agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: 'root-' + randomUUID(), name, arguments: JSON.stringify(args) }] }));
    return batch.results[0].result;
  } finally { toolSet.dispose(); }
}
async function membership(args) {
  const result = await rootTool('dsh_team_replace', args);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
async function waitForTurn(id, beforeSeq) {
  await pollReplacement(signal, timeoutMs, async () => {
    if (ctx.agents.get(id) !== undefined) return;
    const events = await ownSessionEvents(ctx, id, signal);
    return events.some(event => event.type === 'turn/end' && event.seq > beforeSeq) ? true : undefined;
  }, 'MEMBER_DELIVERY_NOT_SETTLED');
}
async function send(id, mode) {
  if (mode) behavior.set(id, mode);
  const beforeSeq = (await ownSessionEvents(ctx, id, signal)).at(-1)?.seq ?? -1;
  const sent = await rootTool('send_message', { agent: id, message: 'Isolated acceptance ' + (mode ?? 'delivery') });
  assert.notEqual(sent.isError, true, JSON.stringify(sent));
  await waitForTurn(id, beforeSeq);
}
async function configure(args) {
  const result = await rootTool('dsh_team_configure', args);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
async function configureFourMembers(template) {
  const catalog = await configure({ action: 'roles' });
  assert.deepEqual(catalog.templates.map(row => row.id).sort(), ['architect', 'designer', 'implementer', 'researcher', 'reviewer', 'tester']);
  const before = await configure({ action: 'inspect' });
  assert.equal(before.ok, true, JSON.stringify(before));
  const listedTester = catalog.templates.find(row => row.id === 'tester');
  const custom = { id: 'custom-tester', description: listedTester.description,
    persona_prompt: listedTester.persona_prompt, prompt: listedTester.prompt, native_tool_allowlist: ['team_task_get'] };
  const factory = JSON.parse(await readFile(join(plugin, 'examples/team-template.json'), 'utf8'));
  assert.deepEqual(before.template.members.map(member => member.name), factory.members.map(member => member.name));
  assert.deepEqual(before.template.seed_tasks, factory.seed_tasks);
  const edits = template.members.map(({ agent_preset, ...member }) => {
    if (!before.template.members.some(existing => existing.name === member.name)) {
      delete member.description; delete member.persona_prompt;
    }
    return member;
  });
  const baseArgs = { expectedRevision: before.revision, members: edits, removeMembers: ['implementer'], maxMembers: 8, customTemplates: [custom] };
  const unchangedSeeds = await configure({ action: 'preview', ...baseArgs });
  assert.equal(unchangedSeeds.code, 'SEED_TASK_OWNER_REMOVED', 'deleting an owner without explicit responsibility changes must still refuse');
  const seedTasks = factory.seed_tasks.map(task => ({ ...task, ...(task.owner === 'implementer' ? { owner: 'backend' } : {}) }));
  const args = { ...baseArgs, seedTasks };
  const calls = providerCalls.length;
  const preview = await configure({ action: 'preview', ...args });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.persisted, false); assert.equal(preview.template.members.length, 4);
  assert.deepEqual(preview.template.seed_tasks, seedTasks);
  assert.equal(preview.template.members.find(member => member.name === 'frontend').persona_prompt,
    catalog.templates.find(row => row.id === 'implementer').persona_prompt);
  assert.equal(providerCalls.length, calls);
  forceConfigApproval = true; approvalOutcome = 'rejected';
  const denied = await configure({ action: 'apply', ...args, expectedFingerprint: preview.fingerprint });
  assert.equal(denied.code, 'SANDBOX_ESCALATION_REJECTED');
  assert.equal((await configure({ action: 'inspect' })).revision, before.revision);
  approvalOutcome = 'allowed-once';
  const applied = await configure({ action: 'apply', ...args, expectedFingerprint: preview.fingerprint });
  forceConfigApproval = false;
  assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(applied.persisted, true);
  assert.equal(applied.existingMembersChanged, false); assert.equal(applied.currentSessionNeedsNewRoot, false);
  assert.ok(approvalRequests.some(request => request.outcome === 'rejected'));
  assert.ok(approvalRequests.some(request => request.outcome === 'allowed-once'));
  const stored = await configure({ action: 'inspect' });
  assert.equal(stored.customs[0].id, 'custom-tester'); assert.equal(stored.template.members.length, 4);
  const customPreview = await configure({ action: 'preview', expectedRevision: stored.revision,
    members: [{ name: 'future-tester', role: 'custom-tester', provider: 'isolated-provider', model: 'tester-model', reasoning_effort: 'max' }] });
  assert.equal(customPreview.ok, true, JSON.stringify(customPreview));
  assert.equal(customPreview.template.members.find(member => member.name === 'future-tester').persona_prompt, custom.persona_prompt);
  const tools = await configure({ action: 'tools' });
  const architect = catalog.templates.find(row => row.id === 'architect');
  const implicitPreview = await configure({ action: 'preview', expectedRevision: stored.revision,
    members: [{ name: 'future-architect', role: 'architect', provider: 'isolated-provider', model: 'frontend-model', reasoning_effort: 'max' }] });
  assert.equal(implicitPreview.ok, true, JSON.stringify(implicitPreview));
  assert.deepEqual(implicitPreview.template.members.find(member => member.name === 'future-architect').native_tool_allowlist,
    architect.native_tool_allowlist.filter(name => tools.tools.some(tool => tool.name === name)).sort());
  check('Agent configuration starts from the installed factory defaults, queries six templates, explicitly reassigns seed responsibility and saves the exact four-member roster/custom copy through native approval');
}
async function verifySoloFactory() {
  ROOT = 'session-' + randomUUID(); profileDir = undefined; profileCase = 'multi-role-solo'; scenario = 'solo-launch';
  await startFixture();
  const before = await configure({ action: 'inspect' });
  const factory = JSON.parse(await readFile(join(plugin, 'examples/team-template.json'), 'utf8'));
  assert.deepEqual(before.template.members.map(member => member.name), factory.members.map(member => member.name));
  const solo = member('solo', 'implementer', ['team_task_get']); delete solo.agent_preset; solo.model = 'frontend-model';
  const args = { expectedRevision: before.revision, members: [solo], removeMembers: factory.members.map(member => member.name),
    seedTasks: factory.seed_tasks.map(task => ({ ...task, owner: 'solo' })), maxMembers: 1 };
  const preview = await configure({ action: 'preview', ...args }); assert.equal(preview.ok, true, JSON.stringify(preview));
  forceConfigApproval = true;
  let applied;
  try { applied = await configure({ action: 'apply', ...args, expectedFingerprint: preview.fingerprint }); }
  finally { forceConfigApproval = false; }
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const launched = await command('launch');
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.deepEqual(launched.members.map(member => member.name), ['solo']);
  assert.equal(launched.tasks.length, factory.seed_tasks.length);
  assert.ok(launched.seedAssignments.every(task => task.owner === 'solo'));
  check('a separate fresh factory profile preserves both seed tasks, explicitly reassigns their responsibilities and launches one independent member');
  await stopFixture();
}
async function verifyAlpha2Contracts() {
  if (boot.getDshRuntimeVersion() !== '0.2.3-alpha.2') return;
  ROOT = 'session-' + randomUUID(); profileDir = undefined; profileCase = 'alpha2-live-policy';
  await startFixture({ initialTemplate: multiTemplate() });
  // A retained rc.5 event must never override the live setting on alpha.2.
  rootHandle.agent.session.append('subagent/model-selection-policy', { allowedModels });
  await ctx.agentTeams.setEnabled(rootHandle.agent, true, signal);
  const before = taskSnapshot(), calls = providerCalls.length;
  await setNativeModelRoutes(ctx, rootHandle.agent.session, boot.getDshRuntimeVersion(),
    allowedModels.filter(route => route.model !== 'frontend-model'));
  const revoked = await command('launch');
  assert.equal(revoked.code, 'SESSION_ROUTE_NOT_AUTHORIZED', JSON.stringify(revoked));
  assert.deepEqual(taskSnapshot(), before); assert.equal(providerCalls.length, calls);
  assert.deepEqual(await ctx.subagents.listDescendants(ROOT, signal), []);
  check('live model-route revocation rejects delegation despite retained rc.5 authorization events, with zero child/task/model side effects');
  await setNativeModelRoutes(ctx, rootHandle.agent.session, boot.getDshRuntimeVersion(), undefined);
  assert.equal((await command('launch')).code, 'SESSION_ROUTE_NOT_AUTHORIZED');
  assert.deepEqual(taskSnapshot(), before); assert.equal(providerCalls.length, calls);
  check('disabled live model selection grants no route and never falls back to Session history');
  await setNativeModelRoutes(ctx, rootHandle.agent.session, boot.getDshRuntimeVersion(), allowedModels);
  const authorizedLaunch = await command('launch');
  assert.equal(authorizedLaunch.ok, true, JSON.stringify(authorizedLaunch));
  const inspectedRoles = await membership({ action: 'inspect' });
  const target = inspectedRoles.roles.find(row => row.role === 'frontend');
  assert.ok(target?.currentChildId);
  const retainedRecord = structuredClone(record()), retainedTasks = taskSnapshot(), priorReplacementCalls = providerCalls.length;
  const resolveMetadata = ctx.llm.resolveCallConfig;
  ctx.llm.resolveCallConfig = async function(config, ...args) {
    await setNativeModelRoutes(ctx, rootHandle.agent.session, boot.getDshRuntimeVersion(),
      allowedModels.filter(route => route.model !== 'frontend-model'));
    return Reflect.apply(resolveMetadata, this, [config, ...args]);
  };
  let revokedReplacement;
  try {
    revokedReplacement = await membership({ action: 'replace', role: target.role, expectedOldChildId: target.currentChildId,
      ...routeOf('frontend'), personaPrompt: 'Continue implementation.', prompt: 'Continue.',
      tools: ['team_task_get', 'team_task_update', 'send_message'], progressFacts: 'No replacement work has started.' });
  } finally { ctx.llm.resolveCallConfig = resolveMetadata; }
  assert.equal(revokedReplacement.code, 'REPLACEMENT_ROUTE_UNAUTHORIZED', JSON.stringify(revokedReplacement));
  assert.deepEqual(record(), retainedRecord); assert.deepEqual(taskSnapshot(), retainedTasks);
  assert.equal(providerCalls.length, priorReplacementCalls);
  check('native Settings revocation during awaited replacement model metadata rejects before freezing, spawning or task transfer');
  await stopFixture();

  const saved = multiTemplate(); saved.members[0].native_tool_allowlist.push('working_directory');
  ROOT = 'session-' + randomUUID(); profileDir = undefined; profileCase = 'alpha2-removed-tool';
  await startFixture({ initialTemplate: saved });
  await ctx.agentTeams.setEnabled(rootHandle.agent, true, signal);
  const inspected = await configure({ action: 'inspect' });
  assert.deepEqual(inspected.template.members[0].native_tool_allowlist, saved.members[0].native_tool_allowlist);
  const priorCalls = providerCalls.length, priorTasks = taskSnapshot();
  const unavailable = await command('launch');
  assert.equal(unavailable.code, 'TEAM_TOOL_UNAVAILABLE', JSON.stringify(unavailable));
  assert.deepEqual((await configure({ action: 'inspect' })).template.members[0].native_tool_allowlist,
    saved.members[0].native_tool_allowlist);
  assert.equal(providerCalls.length, priorCalls); assert.deepEqual(taskSnapshot(), priorTasks);
  check('a saved working_directory capability is preserved exactly and explicitly refused when absent from the new Host catalog');
  await stopFixture();
}
async function saveBoundDefaults() {
  const before = await configure({ action: 'inspect' }), retained = structuredClone(record()), tasks = taskSnapshot();
  const childIds = (await ctx.subagents.listDescendants(ROOT, signal)).map(row => row.id).sort();
  const definition = rootHandle.agent.ctx.tools.executable('dsh_team_configure', rootHandle.agent);
  const custom = { ...roleTemplates.resolveRoleTemplate('researcher'), id: 'bound-research', native_tool_allowlist: ['team_task_get'] };
  const args = { expectedRevision: before.revision, customTemplates: [...before.customs, custom],
    members: [{ name: 'frontend', persona_prompt: before.template.members.find(member => member.name === 'frontend').persona_prompt + '\nFuture roots only.' }] };
  const preview = await configure({ action: 'preview', ...args });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  forceConfigApproval = true;
  let applied;
  try { applied = await configure({ action: 'apply', ...args, expectedFingerprint: preview.fingerprint }); }
  finally { forceConfigApproval = false; }
  assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(applied.currentSessionNeedsNewRoot, true);
  assert.equal(applied.existingMembersChanged, false);
  assert.equal(rootHandle.agent.ctx.tools.executable('dsh_team_configure', rootHandle.agent), definition, 'catalog save must not remount the current-team entry');
  assert.deepEqual(record(), retained); assert.deepEqual(taskSnapshot(), tasks);
  assert.deepEqual((await ctx.subagents.listDescendants(ROOT, signal)).map(row => row.id).sort(), childIds);
  assert.ok((await configure({ action: 'inspect' })).customs.some(row => row.id === 'bound-research'));
  check('saving custom catalog and future persona defaults in a bound team does not remount the entry or change existing Sessions, tasks, tools or baseBinding');
}
async function reassign(id, owner) {
  const task = ctx.agentTeams.getTask(rootHandle.agent, id);
  return ctx.agentTeams.updateTask(rootHandle.agent, { taskId: id, expectedRevision: task.revision, action: 'reassign', owner }, signal);
}
async function seedLegacyFixture() {
  profileCase = 'multi-role-upgraded-rc7';
  ROOT = 'session-' + randomUUID(); profileDir = undefined; scenario = 'legacy-launch';
  const legacy = JSON.parse(await readFile(join(legacyPlugin, 'examples/team-template.json'), 'utf8'));
  for (const m of legacy.members) Object.assign(m, { provider: 'isolated-provider', model: m.name + '-model', reasoning_effort: 'max',
    native_tool_allowlist: ['team_task_get', 'team_task_update'], prompt: 'Confirm ready and stop.' });
  await startFixture({ legacy: true, initialTemplate: legacy });
  const oldLaunch = await command('launch'); assert.equal(oldLaunch.ok, true, JSON.stringify(oldLaunch));
  const seed = { rootId: ROOT, oldIds: oldLaunch.members.map(row => row.id), oldTasks: taskSnapshot(),
    oldBinding: record().baseBinding, profileDir, patchPath };
  await stopFixture();
  check('published rc.7 creates the legacy Settings/JSONL with the exact rc.5 Host before upgrade');
  return seed;
}
async function runChecks() {
  const template = multiTemplate();
  await startFixture();
  check('official initProfile/runProfile loads real current-entry Schema.dict and unmodified Web Standard');
  await configureFourMembers(template);
  const launch = await command('launch');
  assert.equal(launch.ok, true, JSON.stringify(launch)); assert.equal(launch.members.length, 4);
  const ids = Object.fromEntries(launch.members.map(row => [row.name, row.id]));
  assert.equal(template.members[0].role, template.members[1].role);
  assert.equal(launch.gate.roles.frontend.admissions, 1); assert.equal(launch.gate.roles.backend.admissions, 1);
  for (const m of template.members) {
    const started = starts.find(row => row.childId === ids[m.name]);
    assert.equal(started.model.model, m.model); assert.equal(started.parent, ROOT);
    assert.deepEqual(visible.find(row => row.childId === ids[m.name]).tools, [...m.native_tool_allowlist].sort());
  }
  check('Lead plus frontend/backend from one implementer template, tester and reviewer launch with independent native Sessions, models and Presets', { ids });
  const seedId = launch.seedAssignments[0].taskId;
  const refused = await membership({ action: 'remove', name: 'backend' });
  assert.equal(refused.code, 'MEMBER_HAS_UNFINISHED_TASKS'); assert.deepEqual(refused.taskIds, [seedId]);
  check('an unclaimed seed owner cannot be silently removed');
  await saveBoundDefaults();
  scenario = 'work';
  await send(ids.frontend, 'frontend-work'); await send(ids.backend, 'backend-work');
  assert.ok(bodies.some(row => row.childId === ids.frontend && row.tool === 'multi_frontend_write'));
  assert.ok(bodies.some(row => row.childId === ids.backend && row.tool === 'multi_backend_write'));
  assert.ok(visible.filter(row => row.childId === ids.frontend).every(row => !row.tools.includes('multi_backend_write')));
  assert.ok(visible.filter(row => row.childId === ids.backend).every(row => !row.tools.includes('multi_frontend_write')));
  const beforeForeign = bodies.length;
  await send(ids.frontend, 'foreign-tool'); assert.equal(bodies.length, beforeForeign);
  check('same-template members execute their own exact tool subset; a forged foreign tool call executes no body');
  const researcher = member('researcher', 'researcher', ['team_task_get', 'multi_research_write']); delete researcher.agent_preset;
  const beforeAddTasks = taskSnapshot(), beforeAddBodies = bodies.length;
  const added = await membership({ action: 'add', member: researcher });
  assert.equal(added.ok, true, JSON.stringify(added)); assert.deepEqual(taskSnapshot(), beforeAddTasks);
  assert.equal(bodies.length, beforeAddBodies, 'new member startup cannot execute business tools before the active record');
  assert.ok(starts.some(row => row.childId === added.childId && row.maxTokens === 1024));
  assert.equal(record().membership.find(entry => entry.name === 'researcher').phase, 'active');
  check('explicit mid-run add persists pending before activation, bounds the readiness turn and enables work only after active', { childId: added.childId });
  await send(added.childId, 'research-work');
  assert.ok(bodies.some(row => row.childId === added.childId && row.tool === 'multi_research_write' && row.phase === 'active'));
  const beforeConflict = providerCalls.filter(call => call.childId !== ROOT).length, beforeRecord = structuredClone(record());
  const duplicate = await membership({ action: 'add', member: researcher });
  assert.equal(duplicate.code, 'MEMBER_NAME_CONFLICT'); assert.equal(providerCalls.filter(call => call.childId !== ROOT).length, beforeConflict); assert.deepEqual(record(), beforeRecord);
  check('duplicate member names are refused without record, task or model side effects');
  const designer = member('designer', 'designer', ['multi_research_write']); delete designer.agent_preset;
  const beforeFailure = taskSnapshot();
  const failed = await membership({ action: 'add', member: designer });
  assert.equal(failed.ok, false); assert.deepEqual(taskSnapshot(), beforeFailure);
  const failedEntry = record().membership.find(entry => entry.name === 'designer');
  assert.equal(failedEntry.phase, 'failed'); assert.equal(failed.memberStateConfirmed, true);
  const beforeFailedResume = providerCalls.filter(call => call.childId === failedEntry.childId).length;
  const failedSeq = (await ownSessionEvents(ctx, failedEntry.childId, signal)).at(-1)?.seq ?? -1;
  await ctx.subagents.sendMessage(rootHandle.agent, failedEntry.childId, [{ type: 'text', text: 'A direct prompt must be refused.' }], { signal });
  await waitForTurn(failedEntry.childId, failedSeq);
  assert.equal(providerCalls.filter(call => call.childId === failedEntry.childId).length, beforeFailedResume);
  check('failed addition retains existing team/tasks and its Session cannot regain execution on a direct native prompt');
  const oldFront = ids.frontend;
  const task = await ctx.agentTeams.createTask(rootHandle.agent, { subject: 'Frontend takeover', description: 'Retain ownership and history.' }, signal);
  workTaskId = task.id; await reassign(task.id, oldFront);
  const replaced = await membership({ action: 'replace', role: 'frontend', expectedOldChildId: oldFront,
    ...routeOf('frontend'), personaPrompt: 'Continue as frontend implementer.', prompt: 'Continue assigned frontend work.',
    tools: template.members[0].native_tool_allowlist, progressFacts: 'Original work and model/tool subsets retained.' });
  assert.equal(replaced.ok, true, JSON.stringify(replaced)); ids.frontend = replaced.newChildId;
  assert.equal(ctx.agentTeams.getTask(rootHandle.agent, task.id).ownerId, ids.frontend);
  check('an arbitrary named member replaces through native Standby ACK, owner transfer and actual candidate task-write proof', { childId: ids.frontend });
  const replacedResearcher = await membership({ action: 'replace', role: 'researcher', expectedOldChildId: added.childId,
    ...routeOf('researcher'), personaPrompt: 'Continue research.', prompt: 'Continue assigned research.',
    tools: researcher.native_tool_allowlist, progressFacts: 'Explicit addition remains a stable logical team member.' });
  assert.equal(replacedResearcher.ok, true, JSON.stringify(replacedResearcher));
  check('an explicitly added member can later use the same native replacement protocol', { childId: replacedResearcher.newChildId });
  const retainedTasks = taskSnapshot(), retainedRecord = structuredClone(record());
  await stopFixture(); await startFixture({ resume: true });
  assert.deepEqual(taskSnapshot(), retainedTasks); assert.deepEqual(record(), retainedRecord);
  assert.ok((await configure({ action: 'inspect' })).customs.some(row => row.id === 'bound-research'));
  const listed = await rootTool('list_agents', {});
  assert.notEqual(listed.isError, true, JSON.stringify(listed));
  assert.ok(nativeAgentRows(listed.value).some(row => row.name === 'frontend')); assert.ok(nativeAgentRows(listed.value).some(row => row.name === 'researcher'));
  const nativeBefore = providerCalls.length;
  const coldSeq = (await ownSessionEvents(ctx, ids.frontend, signal)).at(-1)?.seq ?? -1;
  const delivered = await rootTool('send_message', { agent: 'frontend', message: 'Cold logical frontend continuation.' });
  assert.notEqual(delivered.isError, true, JSON.stringify(delivered));
  await waitForTurn(ids.frontend, coldSeq);
  assert.ok(providerCalls.slice(nativeBefore).some(call => call.childId === ids.frontend));
  assert.equal((await rootTool('send_message', { agent: oldFront, message: 'Forbidden old instance.' })).isError, true);
  check('full Loader/profile/JSONL reload restores every bound Preset, member, task and stable replacement address');
  assert.equal((await membership({ action: 'remove', name: 'frontend' })).code, 'MEMBER_HAS_UNFINISHED_TASKS');
  await reassign(task.id, ROOT);
  const beforeRemoveTasks = taskSnapshot();
  assert.equal((await membership({ action: 'remove', name: 'frontend' })).ok, true);
  assert.deepEqual(taskSnapshot(), beforeRemoveTasks);
  const beforeRemovedResume = providerCalls.filter(call => call.childId === ids.frontend).length;
  const removedSeq = (await ownSessionEvents(ctx, ids.frontend, signal)).at(-1)?.seq ?? -1;
  await ctx.subagents.sendMessage(rootHandle.agent, ids.frontend, [{ type: 'text', text: 'Direct removed Session prompt.' }], { signal });
  await waitForTurn(ids.frontend, removedSeq);
  assert.equal(providerCalls.filter(call => call.childId === ids.frontend).length, beforeRemovedResume);
  assert.equal((await rootTool('send_message', { agent: 'frontend', message: 'Forbidden removed logical name.' })).isError, true);
  check('safe remove requires task reassignment, preserves native tasks and rejects both logical and direct Session continuation');
  const implementationSeed = ctx.agentTeams.getTask(rootHandle.agent, seedId);
  const claimedSeed = await ctx.agentTeams.updateTask(rootHandle.agent, { taskId: seedId, expectedRevision: implementationSeed.revision, action: 'claim' }, signal);
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId: seedId, expectedRevision: claimedSeed.revision, action: 'complete' }, signal);
  for (const seed of launch.seedAssignments.filter(seed => seed.owner === 'reviewer')) await reassign(seed.taskId, ROOT);
  const beforeOriginalRemove = taskSnapshot();
  const removedOriginal = await membership({ action: 'remove', name: 'reviewer' });
  assert.equal(removedOriginal.ok, true, JSON.stringify(removedOriginal));
  assert.equal(removedOriginal.childId, ids.reviewer);
  assert.deepEqual(taskSnapshot(), beforeOriginalRemove);
  check('safe removal preserves the real native id of an original UUID member, without requiring replacement first', { childId: ids.reviewer });
  const removedRecord = structuredClone(record());
  await stopFixture(); await startFixture({ resume: true });
  assert.deepEqual(record(), removedRecord); assert.deepEqual(taskSnapshot(), beforeOriginalRemove);
  const removedCalls = providerCalls.filter(call => call.childId === ids.reviewer).length;
  const reviewerSeq = (await ownSessionEvents(ctx, ids.reviewer, signal)).at(-1)?.seq ?? -1;
  await ctx.subagents.sendMessage(rootHandle.agent, ids.reviewer, [{ type: 'text', text: 'Removed member after cold reload.' }], { signal });
  await waitForTurn(ids.reviewer, reviewerSeq);
  assert.equal(providerCalls.filter(call => call.childId === ids.reviewer).length, removedCalls);
  const afterRemovedReload = await rootTool('list_agents', {});
  assert.equal(afterRemovedReload.isError, false, JSON.stringify(afterRemovedReload));
  assert.equal(nativeAgentRows(afterRemovedReload.value).some(row => ['frontend', 'reviewer'].includes(row.name)), false);
  check('removed original and replacement members remain fenced and hidden after a fresh Loader/registry/JSONL reload');
  await stopFixture();
  await verifySoloFactory();
  await verifyAlpha2Contracts();
  if (legacyPlugin) {
    let seed;
    if (boot.getDshRuntimeVersion() === '0.2.3-alpha.2') {
      legacySeed = await seedNativeLegacy({ executable: legacyHostExecutable, script: fileURLToPath(import.meta.url),
        plugin, legacyPlugin, sourceHead, lab });
      seed = legacySeed.seed;
    } else seed = await seedLegacyFixture();
    profileCase = 'multi-role-upgraded-rc7';
    ROOT = seed.rootId; profileDir = seed.profileDir; patchPath = seed.patchPath;
    const { oldIds, oldTasks, oldBinding } = seed;
    await startFixture({ resume: true });
    assert.equal(record().baseBinding, oldBinding); assert.deepEqual(taskSnapshot(), oldTasks);
    const oldNames = (await ctx.subagents.listDescendants(ROOT, signal)).filter(row => row.depth === 1).map(row => row.id);
    assert.deepEqual(oldNames.sort(), oldIds.sort());
    const legacyAdded = await membership({ action: 'add', member: researcher });
    assert.equal(legacyAdded.ok, true, JSON.stringify(legacyAdded)); assert.equal(record().baseBinding, oldBinding);
    check('an actual published rc.7 two-member team migrates from its original Settings/JSONL and expands only by explicit add', { oldIds, newChildId: legacyAdded.childId });
    await stopFixture();
  }
  assert.deepEqual(errors, []);
}
try {
  if (seedOnly) legacySeed = { seed: await seedLegacyFixture() };
  else await runChecks();
} catch (error) { errors.push(describeNativeError(error)); }
finally {
  try { await boundedCleanup(); } catch (error) { errors.push(describeNativeError(error)); }
  const result = { sourceHead, runtime, platform: process.platform, passed: errors.length === 0, checks, errors, expectedErrors,
    hostVersion: boot.getDshRuntimeVersion(), seed: seedOnly ? legacySeed?.seed : undefined, legacySeed: seedOnly ? undefined : legacySeed,
    legacyPlugin: legacyPlugin ?? null, approvalRequests, providerCalls, observedToolSets: visible, observableBodies: bodies, nativeStarts: starts, accountEnvironmentInherited: false };
  await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.exit(result.passed ? 0 : 1);
}
