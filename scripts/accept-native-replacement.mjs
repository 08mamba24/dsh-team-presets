/** Official Web profile replacement with a local scripted provider and temporary data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plugin = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtime = resolve(process.argv[2] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh');
const receipt = resolve(process.argv[4] ?? 'native-replacement.json');
const sourceHead = process.argv[5] ?? 'working-tree';
const legacyPlugin = process.argv[6] && resolve(process.argv[6]);
const unchangedLegacyDefaults = process.argv[7] === 'unchanged';

// Profile boot resolves home paths and environment-backed providers during
// import. Relaunch before importing runtime modules, with only laboratory
// paths and OS essentials; the operator's profile and credentials are absent.
if (process.env.DSH_REPLACEMENT_ACCEPT_LAB === undefined) {
  const lab = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-replacement-')));
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
      ELECTRON_RUN_AS_NODE: '1', DSH_REPLACEMENT_ACCEPT_LAB: lab,
    };
    const child = spawn(process.execPath, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { cwd: join(lab, 'workspace'), env: environment, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', code => done(code ?? 1));
    });
    process.exitCode = code;
  } finally { await rm(lab, { recursive: true, force: true }); }
  process.exit(process.exitCode ?? 0);
}
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const [boot, { PROFILE_TEMPLATES }, { runProfile }, { createLaunchEnvironmentSnapshot },
  { defineTool }, { scopeOf }] = await Promise.all([
  load('dsh-app-boot'), load('dsh-official-bundles'), load('dsh/profile-boot'),
  load('dsh-launch-environment'), load('dsh-tools'), load('dsh-scope'),
]);
const fromPlugin = path => import(pathToFileURL(join(plugin, path)).href);
const [{ createReplacementStore, REPLACEMENT_OWNER }, { pollReplacement, ownSessionEvents },
  { startReplacement, readReplacementRecord }] = await Promise.all([
  fromPlugin('src/replacement-store.js'), fromPlugin('src/replacement-native.js'), fromPlugin('src/member-replacement.js'),
]);
const lab = process.env.DSH_REPLACEMENT_ACCEPT_LAB;
assert.equal(process.env.DSH_HOME, join(lab, 'harness'));
const workspace = join(lab, 'workspace');
let profileDir, patchPath;
const packageName = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).name;
const ROOT = 'session-' + randomUUID();
let OLD = 'session-' + randomUUID(), legacyStarting = false, simulateOldWrite = false, raceOnFreeze = false;
const route = { provider: 'isolated-provider', model: 'scripted-model', reasoningEffort: 'max' };
const timeoutMs = 5000, signal = AbortSignal.timeout(60000);
const checks = [], errors = [], expectedErrors = [], providerCalls = [], writes = [], originalWrites = [], stages = new Map(), commands = new Map(), faults = [];
const nativeStarts = [];
let failFirstActivation = true;
let ctx, rootHandle, taskId, profileRecords, profileTemplate, faultTaskId;
const check = (name, evidence = {}) => checks.push({ name, passed: true, ...evidence });
const currentOperation = childId => Object.values(profileRecords.get()).flatMap(record => record.operations)
  .find(operation => operation.newChildId === childId || 'session-' + operation.id.slice(8) === childId);
function* toolCall(name, args) {
  const block = { type: 'tool-call', id: 'call-' + randomUUID(), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
}
async function* stream(request) {
  const id = request.sessionId, operation = currentOperation(id);
  providerCalls.push({ childId: id, phase: operation?.phase ?? 'original' });
  if (id === OLD && simulateOldWrite) { simulateOldWrite = false; yield* toolCall('replacement_probe_write', { content: 'Observable old work before the frozen CAS.' }); }
  if (!legacyStarting && id !== OLD && id !== ROOT) {
    if (!operation) throw new Error('UNPLANNED_PROVIDER_CALL');
    const work = ['activating', 'active'].includes(operation.phase), key = id + ':' + (work ? 'work' : 'ready');
    const step = (stages.get(key) ?? 0) + 1; stages.set(key, step);
    if (work && step === 1 && failFirstActivation) {
      failFirstActivation = false; stages.set(key, 0);
      faults.push({ code: 'ISOLATED_CANDIDATE_MODEL_FAILURE', operationId: operation.id });
      throw Object.assign(new Error('ISOLATED_CANDIDATE_MODEL_FAILURE'), { code: 'ISOLATED_CANDIDATE_MODEL_FAILURE' });
    }
    if (!work && step === 1) yield* toolCall('replacement_probe_write', { content: 'FORBIDDEN STANDBY BUSINESS WRITE' });
    if (!work && step >= 2 && step <= operation.taskRefs.length + 1) yield* toolCall('team_task_get', { task_id: operation.taskRefs[step - 2].taskId });
    if (!work && step === operation.taskRefs.length + 2) yield* toolCall('send_message', { agent: 'lead', message: JSON.stringify({
      ready: true, operation: operation.id, handoff: operation.handoffDigest, config: operation.configDigest }) });
    if (work && step === 1) yield* toolCall('replacement_probe_write', { content: 'Actual candidate business work.\n' });
    if (work && step === 2) yield* toolCall('team_task_get', { task_id: taskId });
    if (work && step === 3) {
      const task = ctx.agentTeams.getTask(rootHandle.agent, taskId);
      yield* toolCall('team_task_update', { task_id: taskId, expected_revision: task.revision,
        action: 'edit', description: task.description + '\nCandidate task-write takeover.' });
    }
  }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
async function startFixture(resumeRoot = false, legacy = false) {
  const selectedPlugin = legacy ? legacyPlugin : plugin;
  const nextProfileDir = join(lab, 'harness', 'profiles', legacy ? 'replacement-rc6' : 'replacement-acceptance');
  boot.initProfile(nextProfileDir, [...PROFILE_TEMPLATES.web.bundles, packageName]);
  await mkdir(join(nextProfileDir, 'node_modules'), { recursive: true });
  // Separate immutable installation paths avoid Node's package/symlink cache
  // selecting rc.6 again after upgrade in this one test process. Carry the
  // exact persisted profile patch forward; native JSONL stays in DSH_HOME.
  if (resumeRoot && profileDir !== nextProfileDir) await copyFile(patchPath, join(nextProfileDir, 'cordis.patch.yml'));
  profileDir = nextProfileDir; patchPath = join(profileDir, 'cordis.patch.yml');
  const link = join(profileDir, 'node_modules', packageName);
  await rm(link, { force: true });
  await symlink(selectedPlugin, link, process.platform === 'win32' ? 'junction' : 'dir');
  const template = JSON.parse(await readFile(join(plugin, 'examples/team-template.json'), 'utf8'));
  for (const member of template.members) Object.assign(member, { provider: route.provider, model: route.model,
    reasoning_effort: route.reasoningEffort,
    native_tool_allowlist: ['team_task_get', 'team_task_update', 'send_message', 'replacement_probe_write'] });
  if (!resumeRoot) await writeFile(patchPath, JSON.stringify([{ id: REPLACEMENT_OWNER,
    config: { mode: 'current-session', template, timeoutMs } }]));
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.deepEqual(profile.skippedBundles, [], 'every official and candidate bundle must activate');
  ({ ctx } = await runProfile({
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
    profile: 'replacement-acceptance', resolvedProfile: { profile, installAnchor }, patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
  }));
  const row = () => ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === REPLACEMENT_OWNER);
  assert.ok(row(), 'the candidate bundle must own its real configurable profile entry');
  profileRecords = { get: () => row().value.replacementRecords ?? {} };
  profileTemplate = { get: () => row().value.template };
  const selected = profileTemplate.get();
  const mutate = ctx.settings.mutate;
  ctx.settings.mutate = async function(ns, ops, revision) {
    if (raceOnFreeze && ns === REPLACEMENT_OWNER && ops.some(item => item.value?.operations?.at(-1)?.phase === 'frozen')) {
      raceOnFreeze = false; simulateOldWrite = true;
      await ctx.subagents.sendMessage(rootHandle.agent, OLD, [{ type: 'text', text: 'An old turn arrives just before freeze.' }], { signal });
      await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(OLD) === undefined ? true : undefined, 'OLD_RACE_TURN_NOT_SETTLED');
    }
    return Reflect.apply(mutate, this, [ns, ops, revision]);
  };
  // All services, Preset declarations and current-entry wiring above are the
  // official Web profile. Only model output and the observable work handler
  // below are laboratory fixtures; no real model adapter is called.
  ctx.llm.resolveCallConfig = async config => ({ ...config });
  ctx.llm.prepareCall = async config => ({ config, stream(options) {
    const request = { ...config, ...options };
    return ctx.waterfall(ctx.llm, 'llm/stream', request, () => stream(request));
  } });
  const nativeGetTask = ctx.agentTeams.getTask;
  ctx.agentTeams.getTask = function(caller, id) {
    const operation = Object.values(profileRecords.get()).flatMap(record => record.operations)
      .findLast(operation => operation.phase === 'transferring');
    if (faultTaskId === id && operation?.taskOutcomes.some(outcome => outcome.kind === 'transferred')) {
      faultTaskId = undefined;
      faults.push({ code: 'ISOLATED_TASK_READ_FAILURE', taskId: id, operationId: operation.id });
      throw Object.assign(new Error('ISOLATED_TASK_READ_FAILURE'), { code: 'ISOLATED_TASK_READ_FAILURE' });
    }
    return Reflect.apply(nativeGetTask, this, [caller, id]);
  };
  const nativeStateOf = ctx.sessionProjections.stateOf.bind(ctx.sessionProjections);
  ctx.sessionProjections.stateOf = (session, key) => key === 'subagentModelSelectionPolicy'
    ? [{ provider: route.provider, model: route.model }] : nativeStateOf(session, key);
  ctx.tools.register(defineTool({ name: 'replacement_probe_write', description: 'Write one file in the isolated acceptance workspace.',
    parameters: { content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      (exec.agent.id === OLD ? originalWrites : writes).push({ childId: exec.agent.id, phase: currentOperation(exec.agent.id)?.phase });
      await writeFile(join(workspace, 'replacement-result.txt'), args.content);
      return args.content;
    } }));
  ctx.on('agent/error', ({ error }) => {
    const target = error.code === 'ISOLATED_CANDIDATE_MODEL_FAILURE' ? expectedErrors : errors;
    target.push({ message: error.message, code: error.code });
  });
  ctx.on('subagent/start', info => {
    if (info.parentSessionId !== ROOT) return;
    const child = ctx.agents.get(info.id);
    nativeStarts.push({ id: info.id, childId: child?.id, sessionId: child?.session.id,
      present: Boolean(child), origin: child?.session.header.origin, rootCwd: ctx.workingDirectory.get(rootHandle.agent.session),
      parent: child?.session.header.parentSession, cwd: child && ctx.workingDirectory.get(child.session),
      preset: child && ctx.agentPresets.composedPreset(child.ctx), model: child?.model.current(),
      maxTokens: child?.options.maxTokens, idleHook: typeof child?.whenIdle,
      eventHook: typeof child?.ctx.on, toolGuard: typeof child?.ctx.tools?.guard });
  });
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard'); };
  rootHandle = resumeRoot
    ? await ctx.agents.resume({ resumeSessionId: ROOT, agentOptions: route, setup })
    : await ctx.agents.create({ sessionId: ROOT, meta: { cwd: workspace }, agentOptions: route, setup });
  return selected;
}

async function stopFixture() {
  if (rootHandle) { await rootHandle.agent.whenIdle(); await rootHandle.dispose(); rootHandle = undefined; }
  if (ctx) { const previous = ctx; ctx = undefined; await previous.fiber.dispose(); }
}

async function invokeRootTool(name, args) {
  await rootHandle.agent.whenIdle();
  const toolSet = await ctx.tools.resolve({ agent: rootHandle.agent, modelSelection: route, signal });
  try {
    // An Agent tool already owns the root phase. It cannot acquire root maintenance.
    const batch = await rootHandle.agent.runMaintenance(() => ctx.tools.execute({ agent: rootHandle.agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: 'root-call-' + randomUUID(), name, arguments: JSON.stringify(args) }] }));
    return batch.results[0].result;
  } finally { toolSet.dispose(); }
}

async function invokeReplacement(args) {
  const result = await invokeRootTool('dsh_team_replace', args);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

async function assertNativeAddressing(childId, label) {
  const listed = await invokeRootTool('list_agents', {});
  assert.equal(listed.isError, false, JSON.stringify(listed));
  assert.equal(listed.value.filter(member => member.name === 'implementer').length, 1);
  assert.equal(listed.value.some(member => /^implementer-r\d+(?:\/|$)/.test(member.name)), false);
  const owned = await invokeRootTool('team_task_list', { owner: 'implementer' });
  assert.equal(owned.isError, false, JSON.stringify(owned));
  assert.ok(owned.value.tasks.some(task => task.id === taskId && task.owner === 'implementer'));
  assert.equal((await invokeRootTool('send_message', { agent: OLD, message: 'Forbidden retired address.' })).isError, true);
  const message = `Native logical address ${label}.`;
  const sent = await invokeRootTool('send_message', { agent: 'implementer', message });
  assert.equal(sent.isError, false, JSON.stringify(sent));
  await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(childId) === undefined ? true : undefined, 'LOGICAL_DELIVERY_NOT_SETTLED');
  const events = await ownSessionEvents(ctx, childId, signal);
  const delivered = events.flatMap(event => event.type === 'user/message' ? [event.data]
    : event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : []);
  assert.ok(delivered.some(item => item.source?.senderSessionId === ROOT
    && item.content?.some(block => block.type === 'text' && block.text === message)));
  assert.equal(ctx.agentTeams.getTask(rootHandle.agent, taskId).ownerId, childId);
  check(`real native root send/list/task-owner addressing follows ${label}`, { childId });
}

try {
  const template = await startFixture(false, Boolean(legacyPlugin));
  if (legacyPlugin) {
    legacyStarting = true;
    const launch = await ctx.commands.execute(rootHandle.agent, '/dsh-team launch', [], signal);
    assert.equal(launch.result.kind, 'success', launch.result.text);
    const original = JSON.parse(launch.result.text);
    OLD = original.members.find(member => member.name === 'implementer').id;
    legacyStarting = false;
    assert.equal(Object.hasOwn(profileRecords.get(), ROOT), false, 'old release did not retain a root binding');
    const changed = structuredClone(template); changed.members[0].persona_prompt += '\nFUTURE DEFAULT ONLY';
    const row = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === REPLACEMENT_OWNER);
    if (!unchangedLegacyDefaults) await ctx.settings.update(REPLACEMENT_OWNER, { template: changed }, row.revision);
    await stopFixture(); await startFixture(true);
    const before = providerCalls.length;
    if (unchangedLegacyDefaults) {
      const planned = await ctx.commands.execute(rootHandle.agent, '/dsh-team plan', [], signal);
      assert.equal(planned.result.kind, 'success', planned.result.text);
    } else {
    const attempt = await invokeReplacement({ action: 'replace', role: 'implementer', expectedOldChildId: OLD, ...route,
      personaPrompt: 'New explicit persona.', prompt: 'Continue.', tools: ['team_task_get', 'team_task_update', 'send_message', 'replacement_probe_write'], progressFacts: 'Original team retained.' });
    assert.equal(attempt.code, 'REPLACEMENT_ORIGINAL_TEMPLATE_REQUIRED');
    const rejected = await invokeReplacement({ action: 'adopt', template: changed });
    assert.equal(rejected.code, 'REPLACEMENT_ORIGINAL_TEMPLATE_REQUIRED');
    const adopted = await invokeReplacement({ action: 'adopt', template });
    assert.equal(adopted.ok, true, JSON.stringify(adopted));
    }
    const retained = JSON.parse(createReplacementStore(ctx.settings, ROOT).read().value.baseBinding);
    assert.equal(retained.template.members[0].persona_prompt, template.members[0].persona_prompt);
    assert.equal(providerCalls.length, before, 'bootstrap neither resumes a member nor invokes its model');
    check(unchangedLegacyDefaults ? 'an actual rc.6 team automatically bootstraps an unchanged original binding before managed Presets'
      : 'an actual rc.6 team with changed defaults adopts its original template only after authenticating native launch history and child headers');
  }
  const plan = (await ctx.commands.execute(rootHandle.agent, '/dsh-team plan', [], signal)).result;
  assert.equal(plan.kind, 'success', plan.text);
  const roster = await ctx.agentPresets.list();
  for (const member of template.members) member.agent_preset = roster.find(preset => preset.name === `Launcher role ${member.name}`).id;
  const store = createReplacementStore(ctx.settings, ROOT);
  await ctx.agentTeams.setEnabled(rootHandle.agent, true, signal);
  const dependency = await ctx.agentTeams.createTask(rootHandle.agent, { subject: 'Existing completed prerequisite', description: 'Retain this dependency.' }, signal);
  const claimed = await ctx.agentTeams.updateTask(rootHandle.agent, { taskId: dependency.id, expectedRevision: dependency.revision, action: 'claim' }, signal);
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId: dependency.id, expectedRevision: claimed.revision, action: 'complete' }, signal);
  const task = await ctx.agentTeams.createTask(rootHandle.agent, { subject: 'Continue existing business task',
    description: 'Existing progress and files must survive replacement.', blockedBy: [dependency.id], writeScopes: ['replacement-result.txt'] }, signal);
  taskId = task.id;
  if (!legacyPlugin) {
  const original = await ctx.subagents.startActivation({ provider: 'spawn', parent: rootHandle.agent,
    childId: OLD, name: 'implementer', label: 'Existing implementer', cwd: workspace,
    agentPreset: template.members.find(member => member.name === 'implementer').agent_preset,
    agentOptions: route, prompt: [{ type: 'text', text: 'End this initial acceptance turn.' }],
    signal, delivery: 'parent', maxDepth: 1 });
  assert.equal((await original.result).stopReason, 'completed');
  await rootHandle.agent.whenIdle();
  }
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId, expectedRevision: task.revision,
    action: 'reassign', owner: OLD }, signal);
  const beforeTask = ctx.agentTeams.getTask(rootHandle.agent, taskId);
  let oldCalls = providerCalls.filter(call => call.childId === OLD).length;
  assert.equal(ctx.agents.get(OLD), undefined, 'exercise a genuinely cold settled native member');
  check('a real native old member has a durable unfinished task and is naturally cold after settlement');

  const replacementRequest = { action: 'replace', role: 'implementer', expectedOldChildId: OLD, ...route,
    personaPrompt: 'Continue the existing task with observable evidence.', prompt: 'Perform useful work, then update the task.',
    tools: ['team_task_get', 'team_task_update', 'send_message', 'replacement_probe_write'],
    progressFacts: 'Existing task and description are authoritative; no background jobs or active descendants.' };
  raceOnFreeze = true;
  const raced = await invokeReplacement(replacementRequest);
  assert.equal(raced.code, 'REPLACEMENT_SNAPSHOT_STALE', JSON.stringify(raced));
  const frozenRace = store.read().value.operations.at(-1);
  assert.equal(frozenRace.phase, 'frozen'); assert.equal(frozenRace.newChildId, null);
  assert.equal(ctx.agentTeams.getTask(rootHandle.agent, taskId).ownerId, OLD);
  assert.equal(originalWrites.length, 1, 'the old native turn really produced a non-task side effect before freeze');
  assert.equal((await invokeReplacement({ action: 'cancel', operationId: frozenRace.id })).cancelled, true);
  oldCalls = providerCalls.filter(call => call.childId === OLD).length;
  replacementRequest.progressFacts += ' Reconciled the observable old pre-freeze file write; the previous frozen plan was explicitly cancelled.';
  check('a completed cold old turn between observation and frozen CAS keeps the plan frozen and creates no candidate or owner transfer');
  const firstAttempt = await invokeReplacement(replacementRequest);
  assert.notEqual(firstAttempt.ok, true);
  const failedActivation = store.read().value.operations.at(-1);
  assert.equal(failedActivation.phase, 'recovering');
  const result = await invokeReplacement({ action: 'recover', operationId: failedActivation.id });
  assert.equal(result.newChildId, failedActivation.newChildId);
  assert.equal(expectedErrors.length, 1);
  check('a failed accepted activation resumes the same candidate Session and does not spawn a duplicate');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.phase, 'active'); assert.equal(result.takeoverProof.kind, 'task-write');
  const afterTask = ctx.agentTeams.getTask(rootHandle.agent, taskId);
  assert.equal(afterTask.id, beforeTask.id); assert.equal(afterTask.ownerId, result.newChildId);
  assert.deepEqual(afterTask.blockedBy, beforeTask.blockedBy); assert.deepEqual(afterTask.writeScopes, beforeTask.writeScopes);
  assert.ok(afterTask.description.startsWith(beforeTask.description));
  assert.ok(writes.length > 0 && writes.every(write => ['activating', 'active'].includes(write.phase)));
  assert.equal(await readFile(join(workspace, 'replacement-result.txt'), 'utf8'), 'Actual candidate business work.\n');
  check('the native root tool completes Standby, real owner CAS, candidate continuation and a JSONL task-write proof', { result });
  check('business tool bodies run only after activation while task identity, dependency, progress and write scopes survive', { writes });
  await ctx.subagents.sendMessage(rootHandle.agent, OLD, [{ type: 'text', text: 'This retired member must not execute.' }], { signal });
  await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(OLD) === undefined ? true : undefined, 'RETIRED_RESUME_NOT_SETTLED');
  assert.equal(providerCalls.filter(call => call.childId === OLD).length, oldCalls);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  check('a real cold continuation of the retired member reaches no provider or business tool and produces no Agent exception');
  await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(result.newChildId) === undefined ? true : undefined, 'FIRST_ACTIVE_NOT_SETTLED');
  await assertNativeAddressing(result.newChildId, 'the first replacement');
  const secondTask = await ctx.agentTeams.createTask(rootHandle.agent, { subject: 'Second unfinished task',
    description: 'Keep the second task progress.', blockedBy: [dependency.id] }, signal);
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId: secondTask.id, expectedRevision: secondTask.revision,
    action: 'reassign', owner: result.newChildId }, signal);
  faultTaskId = secondTask.id;
  const partial = await invokeReplacement({ ...replacementRequest, expectedOldChildId: result.newChildId });
  assert.notEqual(partial.ok, true);
  const interrupted = store.read().value.operations.at(-1);
  assert.equal(interrupted.phase, 'recovering');
  assert.equal(interrupted.taskOutcomes.filter(outcome => outcome.kind === 'transferred').length, 1);
  const candidatesBeforeRecovery = (await ctx.agentPresets.list()).filter(preset => preset.id === interrupted.presetId).length;
  const recovered = await invokeReplacement({ action: 'recover', operationId: interrupted.id });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.newChildId, interrupted.newChildId);
  assert.equal((await ctx.agentPresets.list()).filter(preset => preset.id === interrupted.presetId).length, candidatesBeforeRecovery);
  assert.equal(recovered.transferred.length, 2);
  assert.equal(ctx.agentTeams.getTask(rootHandle.agent, secondTask.id).ownerId, recovered.newChildId);
  assert.deepEqual(ctx.agentTeams.getTask(rootHandle.agent, secondTask.id).blockedBy, [dependency.id]);
  check('a second replacement recovers a real partial multi-task transfer using the same candidate and preserves native dependencies', { faults });
  await assertNativeAddressing(recovered.newChildId, 'the second replacement');
  const cancelAfterTransfer = await invokeReplacement({ action: 'cancel', operationId: recovered.operationId });
  assert.equal(cancelAfterTransfer.code, 'REPLACEMENT_CANNOT_CANCEL_AFTER_TRANSFER');
  const activeId = recovered.newChildId;
  const abandoned = startReplacement(readReplacementRecord(store.read().value), { role: 'implementer', oldChildId: activeId,
    handoffDigest: 'c'.repeat(64), taskRefs: [], instanceName: 'implementer-r99', candidateConfig: JSON.stringify({
      ...route, role: 'implementer', personaPrompt: 'Never spawned.', prompt: 'Never executed.' }) });
  await store.write(abandoned.record, store.read().revision);
  const cancelled = await invokeReplacement({ action: 'cancel', operationId: abandoned.operationId });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled)); assert.equal(cancelled.phase, 'aborted');
  assert.equal(store.read().value.operations.at(-1).newChildId, null);
  check('explicit native cancellation safely exits an unspawned frozen plan while post-owner cancellation is refused');
  await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(activeId) === undefined ? true : undefined, 'RECOVERED_ACTIVE_NOT_SETTLED');
  const pending = await ctx.agentTeams.createTask(rootHandle.agent, { subject: 'New pending prerequisite', description: 'Do not remove this dependency.' }, signal);
  let changing = ctx.agentTeams.getTask(rootHandle.agent, taskId);
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId, expectedRevision: changing.revision,
    action: 'set_dependencies', blockedBy: [pending.id] }, signal);
  const beforeBlocked = store.read().value;
  const blocked = await invokeReplacement({ ...replacementRequest, expectedOldChildId: activeId });
  assert.equal(blocked.code, 'REPLACEMENT_TASK_BLOCKED');
  assert.deepEqual(store.read().value, beforeBlocked);
  changing = ctx.agentTeams.getTask(rootHandle.agent, taskId);
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId, expectedRevision: changing.revision,
    action: 'set_dependencies', blockedBy: [dependency.id] }, signal);
  check('native reassign dependency constraints refuse a blocked owned task before any frozen record or candidate');

  await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(activeId) === undefined ? true : undefined, 'ACTIVE_NOT_SETTLED');
  await rootHandle.agent.whenIdle();
  const savedRecord = store.read().value;
  const changedDefaults = structuredClone(template);
  changedDefaults.members[0].persona_prompt = 'Changed future defaults; preserve the already bound root.';
  await ctx.settings.update(REPLACEMENT_OWNER, { template: changedDefaults }, store.read().revision);
  await stopFixture();
  await startFixture(true);
  assert.ok(ctx.tools.get('dsh_team_replace', scopeOf(rootHandle.agent.ctx)), 'cold root tools must mount before any command is invoked');
  assert.deepEqual(createReplacementStore(ctx.settings, ROOT).read().value, savedRecord);
  const resumedInspect = await invokeReplacement({ action: 'inspect' });
  assert.equal(resumedInspect.roles.find(role => role.role === 'implementer').currentChildId, activeId);
  const coldOldCalls = providerCalls.filter(call => call.childId === OLD).length;
  await ctx.subagents.sendMessage(rootHandle.agent, OLD, [{ type: 'text', text: 'Retired after complete reload.' }], { signal });
  await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(OLD) === undefined ? true : undefined, 'RELOADED_OLD_NOT_SETTLED');
  assert.equal(providerCalls.filter(call => call.childId === OLD).length, coldOldCalls);
  const activeCalls = providerCalls.filter(call => call.childId === activeId).length;
  stages.delete(activeId + ':work');
  await ctx.subagents.sendMessage(rootHandle.agent, activeId, [{ type: 'text', text: 'Continue after complete reload.' }], { signal });
  await pollReplacement(signal, timeoutMs, async () => ctx.agents.get(activeId) === undefined
    && providerCalls.filter(call => call.childId === activeId).length > activeCalls ? true : undefined, 'RELOADED_ACTIVE_NOT_SETTLED');
  assert.equal(ctx.agentTeams.getTask(rootHandle.agent, taskId).ownerId, activeId);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  check('fresh Loader/profile/JSONL reload mounts the original and candidate Presets before continuation, retains the current mapping, blocks old and permits new');
  await assertNativeAddressing(activeId, 'the retained replacement after full reload');

} catch (error) {
  checks.push({ name: 'native replacement failure', passed: false, error: { code: error.code ?? null, message: error.message, stack: error.stack }, errors });
} finally {
  await stopFixture().catch(error => { errors.push({ message: error.message }); });
  await rm(lab, { recursive: true, force: true });
}
const hashes = {};
for (const name of ['current-entry.js', 'src/team-addressing.js', 'role-control.js', 'src/launcher-current.js', 'src/launcher-driver.js', 'src/launcher-replace.js', 'src/member-replacement.js',
  'src/replacement-native.js', 'src/replacement-store.js', 'launcher-role.js', 'src/team-replace.js']) {
  hashes[name] = createHash('sha256').update(await readFile(join(plugin, name))).digest('hex');
}
const result = { sourceHead, runtime, isolatedDataRemoved: true, passed: checks.length > 0 && checks.every(check => check.passed) && errors.length === 0,
  profile: { bundles: [...PROFILE_TEMPLATES.web.bundles, packageName], standard: 'official-unmodified-web',
    accountCredentialsInherited: false, scriptedModel: true },
  hashes, checks, errors, expectedErrors, providerCalls, writes, originalWrites, faults, nativeStarts };
await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.passed) process.exitCode = 1;
