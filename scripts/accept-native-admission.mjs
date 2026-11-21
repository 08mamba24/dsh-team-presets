/**
 * Isolated native admission acceptance for a physical DSH runtime.
 *
 * Uses AgentPresetRegistry, AgentRegistry, AgentLoop, the native executor and a
 * temporary JSONL Session store. Provider, approval and tool bodies are local
 * fixtures; no Host daemon, account, network model, profile or user Session is used.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(process.argv[2]
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh');
const plugin = resolve(process.argv[3] ?? join(here, '..'));
const receipt = resolve(process.argv[4] ?? join(here, 'native-admission-result.json'));
const sourceHead = process.argv[5] ?? 'working-tree';
const packageUrl = pathToFileURL(join(plugin, 'package.json')).href;
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);

const [cordis, loaderModule, agentModule, loopModule, sessionModule, projectionModule,
  promptModule, toolsModule, executorModule, llm, presetModule, persistenceModule] = await Promise.all([
  load('cordis'), load('cordis-plugin-loader'), load('dsh-agent'), load('dsh-agent-loop'),
  load('dsh-session'), load('dsh-session-projection'), load('dsh-system-prompt'),
  load('dsh-tools'), load('dsh-tool-executor-native'), load('dsh-llm'),
  load('dsh-agent-preset-registry'), load('dsh-session-persistence-jsonl'),
]);
const { Context } = cordis;
const { Loader } = loaderModule;
const { AgentRegistry } = agentModule;
const { AgentLoop } = loopModule;
const { SessionStore } = sessionModule;
const { SessionProjectionRegistry } = projectionModule;
const { SystemPrompt } = promptModule;
const { ToolsService, defineTool } = toolsModule;
const { NativeToolExecutor } = executorModule;
const { AgentPresetRegistry } = presetModule;
const { startReplacement, readReplacementRecord, transitionReplacement } = await import(
  pathToFileURL(join(plugin, 'src/member-replacement.js')).href);

const ROOT = 'session-' + randomUUID();
const OLD = 'session-' + randomUUID();
const ORDINARY = 'session-' + randomUUID();
const CANDIDATE = 'session-' + randomUUID();
const ROLE_PRESET = 'native-admission-role-' + randomUUID();
const CANDIDATE_PRESET = 'native-admission-candidate-' + randomUUID();
const HANDOFF = 'a'.repeat(64);
const checks = [];
const check = (name, passed, evidence = {}) => checks.push({ name, passed: Boolean(passed), ...evidence });
const describeError = error => ({ code: error?.code ?? null, message: error?.message ?? String(error), stack: error?.stack });
const hashes = {};
for (const name of ['launcher-role.js', 'src/launcher-native.js', 'src/member-replacement.js', 'src/role-tools.js']) {
  hashes[name] = createHash('sha256').update(await readFile(join(plugin, name))).digest('hex');
}

const started = startReplacement(readReplacementRecord(undefined), {
  role: 'implementer', oldChildId: OLD, handoffDigest: HANDOFF,
  taskRefs: [{ taskId: 'task-native-admission', revision: 1 }],
});
const recordState = { value: started.record, throwRead: false };
const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-native-admission-'));

async function boot() {
  const rootContext = new Context();
  const ctx = rootContext.extend({ baseUrl: packageUrl });
  const stats = { prepare: 0, stream: 0, approval: 0, bodies: {}, agentErrors: [] };
  const reset = () => {
    stats.prepare = 0; stats.stream = 0; stats.approval = 0; stats.bodies = {}; stats.agentErrors = [];
  };
  // Loader ownership and base URL match the package-local Preset registration path.
  new Loader(ctx, { baseUrl: packageUrl });
  ctx.provide('settings', {
    configure() { return () => {}; },
    describe() {
      if (recordState.throwRead) throw new Error('isolated settings projection unavailable');
      return [{ ns: 'dsh-native-current-team', revision: 1,
        value: { replacementRecords: { [ROOT]: recordState.value ?? { version: 1, operations: [] } } } }];
    },
  });
  ctx.provide('llm', {
    async prepareCall(config) {
      stats.prepare++;
      return { config, stream() {
        stats.stream++;
        throw new Error('ISOLATED_PROVIDER_CONTROL_REACHED');
      } };
    },
  });
  ctx.provide('approval', { async request() {
    stats.approval++;
    return 'allowed-once';
  } });
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(persistenceModule.default ?? persistenceModule, { root: storageRoot, compression: 'none' });
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolsService);
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  for (const name of ['write', 'team_task_get', 'send_message']) {
    ctx.tools.register(defineTool({ name, description: `Isolated native admission fixture: ${name}`,
      parameters: {}, output, execute(args) {
        stats.bodies[name] = (stats.bodies[name] ?? 0) + 1;
        return JSON.stringify({ name, args });
      } }));
  }
  ctx.on('agent/error', ({ error }) => { stats.agentErrors.push(describeError(error)); });
  const loop = ctx.plugin(AgentLoop, { agents: [] });
  await loop;
  await ctx.plugin(AgentPresetRegistry, { default: ROLE_PRESET });
  return { rootContext, ctx, loop, stats, reset };
}

async function registerRole(env, id, config) {
  return env.ctx.agentPresets.register({ id, name: `Native admission ${id}`, plugins: [{
    id: `${id}-role`, name: 'dsh-subagent-live-rc2-local/launcher-role',
    config: { ...config, replacementOwner: 'dsh-native-current-team' },
  }] });
}

async function create(env, id, parentId, presetId) {
  return env.ctx.agents.create({
    sessionId: id,
    meta: parentId === undefined ? {} : { origin: 'subagent', parentSession: parentId, agentPreset: presetId },
    agentOptions: { provider: 'isolated-fixture', model: 'no-network' },
    ...(presetId === undefined ? {} : {
      setup: childCtx => env.ctx.agentPresets.mount(childCtx, presetId).then(() => undefined),
    }),
  });
}

async function resume(env, id, presetId) {
  return env.ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: { provider: 'isolated-fixture', model: 'no-network' },
    ...(presetId === undefined ? {} : {
      setup: childCtx => env.ctx.agentPresets.mount(childCtx, presetId).then(() => undefined),
    }),
  });
}

async function drive(handle, marker) {
  const message = llm.createUserMessage({ source: { kind: 'human' },
    content: [{ type: 'text', text: marker }] });
  handle.agent.send(message, 'next-turn', true);
  await handle.agent.whenIdle();
  return handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data;
}

let callOrdinal = 0;
async function call(env, handle, name, args = {}) {
  const signal = new AbortController().signal;
  const toolSet = await env.ctx.tools.resolve({ agent: handle.agent,
    modelSelection: { provider: 'isolated-fixture', model: 'no-network' }, signal });
  try {
    const batch = await env.ctx.tools.execute({ agent: handle.agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: `native-admission-${++callOrdinal}`, name,
        arguments: JSON.stringify(args) }] });
    return batch.results[0].result;
  } finally { toolSet.dispose(); }
}

async function close(env, handles, unregisters) {
  for (const handle of handles.reverse()) await handle.dispose().catch(() => {});
  for (const unregister of unregisters.reverse()) await unregister().catch(() => {});
  await env.loop.dispose().catch(() => {});
  await env.rootContext.fiber.dispose().catch(() => {});
}

let setupError;
let firstHistoryCount = 0;
try {
  const env = await boot(), handles = [], unregisters = [];
  try {
    const root = await create(env, ROOT); handles.push(root);
    unregisters.push(await registerRole(env, ROLE_PRESET, { ownedSessionId: ROOT, roleName: 'implementer',
      personaPrompt: 'Isolated native admission role.', tools: ['write'] }));
    unregisters.push(await registerRole(env, CANDIDATE_PRESET, { ownedSessionId: ROOT, roleName: 'implementer',
      personaPrompt: 'Isolated native admission candidate.', tools: ['write'], standbyOperationId: started.operationId }));

    const ordinary = await create(env, ORDINARY, ROOT, ROLE_PRESET); handles.push(ordinary);
    env.reset();
    const ordinaryWrite = await call(env, ordinary, 'write');
    await drive(ordinary, 'ORDINARY_ROLE_REACHES_PROVIDER');
    check('real-preset-normal-role-reaches-provider', ordinaryWrite.isError !== true
      && env.stats.bodies.write === 1 && env.stats.prepare === 1 && env.stats.stream === 1,
    { stats: structuredClone(env.stats), composedPreset: env.ctx.agentPresets.composedPreset(ordinary.agent.ctx) });

    const old = await create(env, OLD, ROOT, ROLE_PRESET); handles.push(old);
    env.reset();
    const oldWrite = await call(env, old, 'write');
    const firstEnd = await drive(old, 'FROZEN_OLD_INPUT_PERSISTS_WITHOUT_EXECUTION');
    const firstEvents = old.agent.session.snapshotEvents();
    firstHistoryCount = firstEvents.length;
    check('real-preset-frozen-old-blocks-direct-tool-and-ui-input', oldWrite.isError === true
      && (env.stats.bodies.write ?? 0) === 0 && env.stats.prepare === 0 && env.stats.stream === 0
      && env.stats.agentErrors.length === 0 && JSON.stringify(firstEvents).includes('FROZEN_OLD_INPUT_PERSISTS_WITHOUT_EXECUTION'),
    { stats: structuredClone(env.stats), turnEnd: firstEnd, historyCount: firstHistoryCount });

    const candidate = await create(env, CANDIDATE, ROOT, CANDIDATE_PRESET); handles.push(candidate);
    env.reset();
    const taskRead = await call(env, candidate, 'team_task_get', { task_id: 'task-native-admission' });
    const foreignRead = await call(env, candidate, 'team_task_get', { task_id: 'foreign-task' });
    const ack = await call(env, candidate, 'send_message', { agent: 'lead', message: JSON.stringify({
      ready: true, operation: started.operationId, handoff: HANDOFF,
    }) });
    const wrongAck = await call(env, candidate, 'send_message', { agent: 'reviewer', message: JSON.stringify({
      ready: true, operation: started.operationId, handoff: HANDOFF,
    }) });
    const standbyWrite = await call(env, candidate, 'write');
    await drive(candidate, 'STANDBY_CANDIDATE_READ_AND_ACK_ONLY');
    const candidateSchemas = env.ctx.tools.schemas(candidate.agent).map(tool => tool.name).sort();
    check('real-preset-born-standby-has-bounded-transport-before-child-binding', taskRead.isError !== true
      && foreignRead.isError === true && ack.isError !== true && wrongAck.isError === true && standbyWrite.isError === true
      && env.stats.bodies.team_task_get === 1 && env.stats.bodies.send_message === 1
      && (env.stats.bodies.write ?? 0) === 0 && env.stats.prepare === 1 && env.stats.stream === 1
      && JSON.stringify(candidateSchemas) === JSON.stringify(['send_message', 'team_task_get', 'write']),
    { stats: structuredClone(env.stats), schemas: candidateSchemas });

    let active = transitionReplacement(recordState.value, started.operationId, 'standby', Date.now() + 1,
      { newChildId: CANDIDATE });
    active = transitionReplacement(active, started.operationId, 'ready', Date.now() + 2);
    active = transitionReplacement(active, started.operationId, 'transferring', Date.now() + 3);
    active = transitionReplacement(active, started.operationId, 'active', Date.now() + 4);
    recordState.value = active;
    env.reset();
    const activeWrite = await call(env, candidate, 'write');
    const activeRead = await call(env, candidate, 'team_task_get', { task_id: 'task-native-admission' });
    check('activation-grants-exact-requested-work-authority', activeWrite.isError !== true
      && activeRead.isError === true && env.stats.bodies.write === 1 && (env.stats.bodies.team_task_get ?? 0) === 0,
    { stats: structuredClone(env.stats) });

    // Materialize the root session so the second runtime can restore the same ownership identity.
    env.reset(); await drive(root, 'ROOT_PERSISTENCE_SEED');
  } finally { await close(env, handles, unregisters); }

  const resumedEnv = await boot(), resumedHandles = [], resumedUnregisters = [];
  try {
    const root = await resume(resumedEnv, ROOT); resumedHandles.push(root);
    resumedUnregisters.push(await registerRole(resumedEnv, ROLE_PRESET, { ownedSessionId: ROOT,
      roleName: 'implementer', personaPrompt: 'Isolated native admission role.', tools: ['write'] }));
    const old = await resume(resumedEnv, OLD, ROLE_PRESET); resumedHandles.push(old);
    resumedEnv.reset();
    const write = await call(resumedEnv, old, 'write');
    const end = await drive(old, 'COLD_RESUME_STILL_DENIES_RETIRED_MEMBER');
    const events = old.agent.session.snapshotEvents();
    check('cold-resume-remounts-admission-before-execution-and-preserves-history', old.agent.id === OLD
      && resumedEnv.ctx.agentPresets.composedPreset(old.agent.ctx) === ROLE_PRESET
      && write.isError === true && (resumedEnv.stats.bodies.write ?? 0) === 0
      && resumedEnv.stats.prepare === 0 && resumedEnv.stats.stream === 0 && resumedEnv.stats.agentErrors.length === 0
      && events.length > firstHistoryCount
      && JSON.stringify(events).includes('FROZEN_OLD_INPUT_PERSISTS_WITHOUT_EXECUTION')
      && JSON.stringify(events).includes('COLD_RESUME_STILL_DENIES_RETIRED_MEMBER'),
    { stats: structuredClone(resumedEnv.stats), turnEnd: end, beforeHistoryCount: firstHistoryCount,
      afterHistoryCount: events.length, source: 'resume' });
  } finally { await close(resumedEnv, resumedHandles, resumedUnregisters); }
} catch (error) {
  setupError = describeError(error);
} finally {
  await rm(storageRoot, { recursive: true, force: true });
}

const report = {
  sourceHead, plugin, runtime, node: process.versions.node, sourceHashes: hashes,
  checks, setupError, passed: setupError === undefined && checks.length === 5 && checks.every(item => item.passed),
  boundary: 'Physical rc.5 Cordis Loader, AgentPresetRegistry composition, AgentRegistry, AgentLoop, native executor and temporary JSONL cold resume. Provider, approval and tool bodies are isolated local fixtures. No Host daemon, network provider, account, daily profile or user Session.',
};
await writeFile(receipt, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ receipt, passed: report.passed, setupError,
  checks: checks.map(({ name, passed }) => ({ name, passed })) }, null, 2) + '\n');
process.exitCode = report.passed ? 0 : 1;
