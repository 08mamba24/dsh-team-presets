/** End-to-end native replacement with a local scripted provider and temporary data. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plugin = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtime = resolve(process.argv[2] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh');
const receipt = resolve(process.argv[4] ?? 'native-replacement.json');
const sourceHead = process.argv[5] ?? 'working-tree';
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const modules = await Promise.all(['cordis', 'cordis-plugin-loader', 'dsh-config-editor', 'dsh-settings',
  'dsh-app-boot', 'dsh-session', 'dsh-session-projection', 'dsh-session-persistence-jsonl', 'dsh-session-query-sqlite',
  'dsh-agent', 'dsh-agent-loop', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native',
  'dsh-agent-preset-registry', 'dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-agent-team',
  'dsh-tool-agent-team', 'dsh-skill'].map(load));
const [{ Context }, { Loader }, { ConfigEditor }, { SettingsForms }, boot, { SessionStore },
  { SessionProjectionRegistry }, persistence, query, { AgentRegistry }, { AgentLoop }, { SystemPrompt },
  { ToolsService, defineTool }, { NativeToolExecutor }, { AgentPresetRegistry }, subagent, spawn,
  { TeamService }, teamTools, { SkillRegistry }] = modules;
const fromPlugin = path => import(pathToFileURL(join(plugin, path)).href);
const [{ Config }, { applyCurrentLauncher }, { applyTeamReplacement }, { nativeTeamFromHost },
  { createReplacementStore, REPLACEMENT_OWNER }, { pollReplacement, ownSessionEvents },
  { startReplacement, readReplacementRecord }] = await Promise.all([
  fromPlugin('current-entry.js'), fromPlugin('src/launcher-current.js'), fromPlugin('src/team-replace.js'),
  fromPlugin('src/team-host.js'), fromPlugin('src/replacement-store.js'), fromPlugin('src/replacement-native.js'),
  fromPlugin('src/member-replacement.js'),
]);
const lab = await mkdtemp(join(tmpdir(), 'dsh-native-replacement-'));
const profileDir = join(lab, 'profile'), home = join(lab, 'home'), workspace = join(lab, 'workspace');
for (const dir of [profileDir, home, workspace]) await mkdir(dir);
const patchPath = join(profileDir, 'cordis.patch.yml'), basePath = join(lab, 'base.json');
await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
await writeFile(basePath, '[]\n');
await writeFile(patchPath, JSON.stringify([{ insert: [{ id: REPLACEMENT_OWNER,
  name: 'cordis:replacement-profile', config: { mode: 'current-session' } }] }]));
const ROOT = 'session-' + randomUUID(), OLD = 'session-' + randomUUID();
const route = { provider: 'isolated-provider', model: 'scripted-model', reasoningEffort: 'max' };
const timeoutMs = 5000, signal = AbortSignal.timeout(30000);
const checks = [], errors = [], expectedErrors = [], providerCalls = [], writes = [], stages = new Map(), commands = new Map(), faults = [];
let failFirstActivation = true;
let ctx, rootHandle, taskId, profileRecords, profileTemplate, control, faultTaskId;
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
  if (id !== OLD && id !== ROOT) {
    if (!operation) throw new Error('UNPLANNED_PROVIDER_CALL');
    const work = ['activating', 'active'].includes(operation.phase), key = id + ':' + (work ? 'work' : 'ready');
    const step = (stages.get(key) ?? 0) + 1; stages.set(key, step);
    if (work && step === 1 && failFirstActivation) {
      failFirstActivation = false; stages.set(key, 0);
      faults.push({ code: 'ISOLATED_CANDIDATE_MODEL_FAILURE', operationId: operation.id });
      throw Object.assign(new Error('ISOLATED_CANDIDATE_MODEL_FAILURE'), { code: 'ISOLATED_CANDIDATE_MODEL_FAILURE' });
    }
    if (!work && step === 1) yield* toolCall('write', { content: 'FORBIDDEN STANDBY BUSINESS WRITE' });
    if (!work && step >= 2 && step <= operation.taskRefs.length + 1) yield* toolCall('team_task_get', { task_id: operation.taskRefs[step - 2].taskId });
    if (!work && step === operation.taskRefs.length + 2) yield* toolCall('send_message', { agent: 'lead', message: JSON.stringify({
      ready: true, operation: operation.id, handoff: operation.handoffDigest, config: operation.configDigest }) });
    if (work && step === 1) yield* toolCall('write', { content: 'Actual candidate business work.\n' });
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
async function startFixture(resumeRoot = false) {
  ctx = new Context();
  const packageUrl = pathToFileURL(join(plugin, 'package.json')).href;
  ctx.baseUrl = packageUrl;
  await ctx.plugin(Loader, { baseUrl: packageUrl });
  ctx.loader.builtins['replacement-profile'] = { Config, apply(_scope, raw) { profileRecords = raw.replacementRecords; profileTemplate = raw.template; } };
  ctx.provide('profileContext', { name: 'isolated-replacement', dir: profileDir, patchPath, home,
    cwd: workspace, installAnchor: join(runtime, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: '1' });
  await boot.mountRootInclude(ctx, basePath, boot.readProfilePatches('dsh', ctx.profileContext));
  await ctx.loader.await();
  await ctx.plugin(ConfigEditor); await ctx.plugin(SettingsForms);
  ctx.provide('commands', { register(spec) { commands.set(spec.name, spec); return () => commands.delete(spec.name); } });
  const directories = new Map();
  ctx.provide('workingDirectory', { get: session => directories.get(session.id) ?? session.header.cwd ?? workspace,
    async ensure(agent) { return this.get(agent.session); },
    async set(agent, cwd) { directories.set(agent.id, cwd); return cwd; } });
  ctx.provide('llm', { async resolveCallConfig(config) { return { ...config }; },
    async prepareCall(config) { return { config, stream }; } });
  ctx.provide('approval', { async request() { return 'allowed-once'; } });
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(persistence.default ?? persistence, { root: join(lab, 'sessions'), compression: 'none' });
  await ctx.plugin(query.default, { path: join(lab, 'query.sqlite'), openAt: 'never' });
  await ctx.plugin(AgentRegistry); await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolsService); ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  new SkillRegistry(ctx);
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' });
  await ctx.plugin(subagent.SubagentRuntime, { maxDepth: 1 });
  await ctx.plugin(spawn.default ?? spawn, { providerName: 'spawn' });
  await ctx.plugin(TeamService); await ctx.plugin(teamTools.default ?? teamTools);
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
  ctx.tools.register(defineTool({ name: 'write', description: 'Write one file in the isolated acceptance workspace.',
    parameters: { content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      writes.push({ childId: exec.agent.id, phase: currentOperation(exec.agent.id)?.phase });
      await writeFile(join(workspace, 'replacement-result.txt'), args.content);
      return args.content;
    } }));
  ctx.on('agent/error', ({ error }) => {
    const target = error.code === 'ISOLATED_CANDIDATE_MODEL_FAILURE' ? expectedErrors : errors;
    target.push({ message: error.message, code: error.code });
  });
  await ctx.plugin(AgentLoop, { agents: [] });
  const template = JSON.parse(await readFile(join(plugin, 'examples/team-template.json'), 'utf8'));
  for (const member of template.members) Object.assign(member, { provider: route.provider, model: route.model,
    reasoning_effort: route.reasoningEffort, native_tool_allowlist: ['team_task_get', 'team_task_update', 'send_message', 'write'] });
  const native = await nativeTeamFromHost();
  const selected = profileTemplate?.get() ?? template;
  control = await applyCurrentLauncher(ctx, { mode: 'current-session', template: selected, timeoutMs }, native.nativeSubagent, native.controlEntry,
    { readTemplate: () => profileTemplate?.get() ?? template, readRecords: () => profileRecords.get() });
  await applyTeamReplacement(ctx, control, { defineTool });
  rootHandle = resumeRoot
    ? await ctx.agents.resume({ resumeSessionId: ROOT, agentOptions: route })
    : await ctx.agents.create({ sessionId: ROOT, meta: { cwd: workspace }, agentOptions: route });
  return selected;
}

async function stopFixture() {
  if (rootHandle) { await rootHandle.agent.whenIdle(); await rootHandle.dispose(); rootHandle = undefined; }
  if (ctx) { const previous = ctx; ctx = undefined; await previous.fiber.dispose(); }
}

async function invokeReplacement(args) {
  await rootHandle.agent.whenIdle();
  const toolSet = await ctx.tools.resolve({ agent: rootHandle.agent, modelSelection: route, signal });
  try {
    // An Agent tool already owns the root phase. It cannot acquire root maintenance.
    const batch = await rootHandle.agent.runMaintenance(() => ctx.tools.execute({ agent: rootHandle.agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: 'replace-' + randomUUID(), name: 'dsh_team_replace', arguments: JSON.stringify(args) }] }));
    assert.notEqual(batch.results[0].result.isError, true, JSON.stringify(batch.results[0].result));
    return JSON.parse(batch.results[0].result.content[0].text);
  } finally { toolSet.dispose(); }
}

try {
  const template = await startFixture();
  const plan = await commands.get('dsh-team').handler({ agent: rootHandle.agent, signal, rawInput: 'plan', attachments: [] });
  assert.equal(plan.kind, 'success', plan.text);
  const roster = await ctx.agentPresets.list();
  for (const member of template.members) member.agent_preset = roster.find(preset => preset.name === `Launcher role ${member.name}`).id;
  const store = createReplacementStore(ctx.settings, ROOT);
  await store.ensure(JSON.stringify({ workspace, template }));
  await ctx.agentTeams.setEnabled(rootHandle.agent, true, signal);
  const dependency = await ctx.agentTeams.createTask(rootHandle.agent, { subject: 'Existing completed prerequisite', description: 'Retain this dependency.' }, signal);
  const claimed = await ctx.agentTeams.updateTask(rootHandle.agent, { taskId: dependency.id, expectedRevision: dependency.revision, action: 'claim' }, signal);
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId: dependency.id, expectedRevision: claimed.revision, action: 'complete' }, signal);
  const task = await ctx.agentTeams.createTask(rootHandle.agent, { subject: 'Continue existing business task',
    description: 'Existing progress and files must survive replacement.', blockedBy: [dependency.id], writeScopes: ['replacement-result.txt'] }, signal);
  taskId = task.id;
  const original = await ctx.subagents.startActivation({ provider: 'spawn', parent: rootHandle.agent,
    childId: OLD, name: 'implementer', label: 'Existing implementer', cwd: workspace,
    agentPreset: template.members.find(member => member.name === 'implementer').agent_preset,
    agentOptions: route, prompt: [{ type: 'text', text: 'End this initial acceptance turn.' }],
    signal, delivery: 'parent', maxDepth: 1 });
  assert.equal((await original.result).stopReason, 'completed');
  await rootHandle.agent.whenIdle();
  await ctx.agentTeams.updateTask(rootHandle.agent, { taskId, expectedRevision: task.revision,
    action: 'reassign', owner: OLD }, signal);
  const beforeTask = ctx.agentTeams.getTask(rootHandle.agent, taskId), oldCalls = providerCalls.filter(call => call.childId === OLD).length;
  assert.equal(ctx.agents.get(OLD), undefined, 'exercise a genuinely cold settled native member');
  check('a real native old member has a durable unfinished task and is naturally cold after settlement');

  const replacementRequest = { action: 'replace', role: 'implementer', expectedOldChildId: OLD, ...route,
    personaPrompt: 'Continue the existing task with observable evidence.', prompt: 'Perform useful work, then update the task.',
    tools: ['team_task_get', 'team_task_update', 'send_message', 'write'],
    progressFacts: 'Existing task and description are authoritative; no background jobs or active descendants.' };
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
  const cancelAfterTransfer = await invokeReplacement({ action: 'cancel', operationId: recovered.operationId });
  assert.equal(cancelAfterTransfer.code, 'REPLACEMENT_CANNOT_CANCEL_AFTER_TRANSFER');
  const activeId = recovered.newChildId;
  const abandoned = startReplacement(readReplacementRecord(store.read().value), { role: 'implementer', oldChildId: activeId,
    handoffDigest: 'c'.repeat(64), taskRefs: [], instanceName: 'implementer-r3', candidateConfig: JSON.stringify({
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
  assert.equal(control.hasBinding(ROOT), true, 'cold bindings must mount before any command is invoked');
  assert.deepEqual(createReplacementStore(ctx.settings, ROOT).read().value, savedRecord);
  const resumedInspect = await control.replacement({ agent: rootHandle.agent, signal, action: 'inspect' });
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

} catch (error) {
  checks.push({ name: 'native replacement failure', passed: false, error: { code: error.code ?? null, message: error.message, stack: error.stack }, errors });
} finally {
  await stopFixture().catch(error => { errors.push({ message: error.message }); });
  await rm(lab, { recursive: true, force: true });
}
const hashes = {};
for (const name of ['src/launcher-current.js', 'src/launcher-driver.js', 'src/launcher-replace.js', 'src/member-replacement.js',
  'src/replacement-native.js', 'src/replacement-store.js', 'launcher-role.js', 'src/team-replace.js']) {
  hashes[name] = createHash('sha256').update(await readFile(join(plugin, name))).digest('hex');
}
const result = { sourceHead, runtime, isolatedDataRemoved: true, passed: checks.length > 0 && checks.every(check => check.passed) && errors.length === 0,
  hashes, checks, errors, expectedErrors, providerCalls, writes, faults };
await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.passed) process.exitCode = 1;
