/** Legacy macOS delegation: change the live directory inside the native tool preflight. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setNativeModelRoutes } from './native-host-contract.mjs';
const [runtime, selected, output, sourceHead = 'working-tree'] = process.argv.slice(2);
assert.equal(process.platform, 'darwin', 'the legacy file-bound entries are macOS only');
const plugin = resolve(selected), workspace = await realpath(process.cwd());
const lab = dirname(workspace);
assert.equal(process.env.DSH_HOME, join(lab, 'harness'));
assert.equal(process.env.HOME, join(lab, 'home'));
assert.equal(process.env.DSH_AGENTS_HOME, join(lab, 'agents'));
process.env.DSH_PRIMARY_RUNTIME = join(dirname(dirname(runtime)), 'runtime/primary-runtime');
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const [boot, { PROFILE_TEMPLATES }, { runProfile }, { createLaunchEnvironmentSnapshot }] = await Promise.all([
  load('dsh-app-boot'), load('dsh-official-bundles'), load('dsh/profile-boot'), load('dsh-launch-environment'),
]);
const fromPlugin = name => import(pathToFileURL(join(plugin, name)).href);
const [{ nativeHostFromApp }, { applyLive }, { applyTeam }, { nativeTeamFromHost }, { bindHostContext }] = await Promise.all([
  fromPlugin('src/host.js'), fromPlugin('src/driver.js'), fromPlugin('src/team-driver.js'),
  fromPlugin('src/team-host.js'), fromPlugin('src/host-adapter.js'),
]);
const packageName = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).name;
const result = { sourceHead, plugin, runtime, passed: false, checks: [], errors: [] };
for (const mode of ['one', 'team']) {
  let ctx, handle, driver;
  const stats = { metadataCalls: 0, providerPrepares: 0, providerStreams: 0, starts: [], ends: [] };
  const commands = new Map(), rootId = 'session-' + randomUUID(), tag = 'native-inner-' + mode;
  const changedDirectory = join(workspace, mode + '-changed'); await mkdir(changedDirectory, { recursive: true });
  const route = model => ({ provider: 'isolated-inner-race', model, reasoningEffort: 'low', maxTokens: 1024 });
  const roles = Object.fromEntries(['implementer', 'reviewer'].map(role => [role, {
    memberName: tag + '-' + role, presetId: 'dsh-live-' + tag + '-' + role, personaNonce: tag + '-' + role + '-nonce',
    maxStreams: role === 'implementer' ? 6 : 5, route: route(role),
  }]));
  const config = mode === 'one' ? { ownedSessionId: rootId, workspace, runTag: tag, timeoutMs: 10000,
    memberName: roles.implementer.memberName, presetId: roles.implementer.presetId,
    personaNonce: roles.implementer.personaNonce, route: roles.implementer.route }
    : { mode: 'team', ownedSessionId: rootId, workspace, runTag: tag, timeoutMs: 10000, roles };
  const marker = mode === 'one' ? '.dsh-subagent-live.json' : '.dsh-team-live.json';
  try {
    await writeFile(join(workspace, marker), JSON.stringify({ purpose: mode === 'one' ? 'dsh-subagent-live-one' : 'dsh-native-team-pair',
      ownedSessionId: rootId, runTag: tag }), { mode: 0o600, flag: 'wx' });
    const profileDir = join(process.env.DSH_HOME, 'profiles', tag);
    boot.initProfile(profileDir, [...PROFILE_TEMPLATES.web.bundles, packageName]);
    await mkdir(join(profileDir, 'node_modules'), { recursive: true });
    await symlink(plugin, join(profileDir, 'node_modules', packageName));
    const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
    const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
    assert.deepEqual(profile.skippedBundles, []);
    ({ ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
      profile: tag, resolvedProfile: { profile, installAnchor }, patchFiles: [],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] }));
    const register = ctx.commands.register;
    ctx.commands.register = function(definition) {
      commands.set(definition.name, definition); return Reflect.apply(register, this, [definition]);
    };
    ctx.llm.resolveCallConfig = async config => {
      stats.metadataCalls++;
      // Inject only when the pinned native delegation tool calls the resolver,
      // not during root setup, driver preflight or tool-set resolution.
      const stack = new Error('native metadata boundary').stack;
      if (!stats.innerPreflight && stack.includes('/dsh-tool-subagent/')) {
        stats.innerPreflight = { call: stats.metadataCalls, stack };
        await Promise.resolve(); await ctx.workingDirectory.set(handle.agent, changedDirectory);
      }
      return { ...config };
    };
    ctx.llm.prepareCall = async config => {
      stats.providerPrepares++;
      return { config, stream(options) {
        const request = { ...config, ...options };
        return ctx.waterfall(ctx.llm, 'llm/stream', request, async function* () {
          stats.providerStreams++;
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ role: 'implementer', value: 5, personaNonce: roles.implementer.personaNonce }) };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ role: 'implementer', value: 5, personaNonce: roles.implementer.personaNonce }) } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        });
      } };
    };
    ctx.on('subagent/start', info => {
      if (info.parentSessionId !== rootId) return;
      const child = ctx.agents.get(info.id);
      stats.starts.push({ id: info.id, cwd: child && ctx.workingDirectory.get(child.session),
        parentCwd: ctx.workingDirectory.get(handle.agent.session) });
    });
    ctx.on('subagent/end', info => { if (info.parentSessionId === rootId) stats.ends.push({ id: info.id, reason: info.stopReason }); });
    handle = await ctx.agents.create({ sessionId: rootId, meta: { cwd: workspace }, agentOptions: route('implementer'),
      setup: async inner => { await ctx.agentPresets.mount(inner, 'standard'); } });
    await setNativeModelRoutes(ctx, handle.agent.session, boot.getDshRuntimeVersion(),
      Object.values(roles).map(role => ({ provider: role.route.provider, model: role.route.model })));
    const host = mode === 'one' ? await nativeHostFromApp() : await nativeTeamFromHost();
    driver = ctx.plugin({ name: tag, inject: ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets',
      'sessionProjections', 'agentTeams', 'workingDirectory'], async apply(inner) {
      bindHostContext(inner, host.adapter);
      if (mode === 'one') await applyLive(inner, config, host.nativeSubagent);
      else await applyTeam(inner, config, host.nativeSubagent, host.controlEntry);
    } });
    await driver;
    const answer = await commands.get(mode === 'one' ? 'dsh-subagent-live' : 'dsh-team-live').handler({ agent: handle.agent,
      rawInput: mode === 'one' ? 'run-one' : 'run-pair', attachments: [], signal: AbortSignal.timeout(20000) });
    assert.equal(answer.kind, 'error', answer.text);
    assert.ok(stats.innerPreflight, 'the real native tool metadata await must be reached');
    assert.match(answer.text, /CHILD_CONFIGURATION_CHANGED/, JSON.stringify(stats));
    assert.equal(stats.providerStreams, 0);
    assert.equal(stats.starts.length, 1); assert.equal(stats.starts[0].cwd, changedDirectory);
    assert.equal(stats.starts[0].parentCwd, changedDirectory);
    assert.equal(stats.ends.length, 1); assert.equal(stats.ends[0].id, stats.starts[0].id);
    result.checks.push({ name: mode + '-native-inner-preflight-directory-race', passed: true, stats, code: 'CHILD_CONFIGURATION_CHANGED' });
  } catch (error) {
    result.errors.push({ mode, code: error.code, message: error.message, stack: error.stack, stats });
    break;
  } finally {
    await driver?.dispose();
    if (handle) { await handle.agent.whenIdle(); await handle.dispose(); }
    await ctx?.fiber.dispose();
    await rm(join(workspace, marker), { force: true });
  }
}
result.passed = result.checks.length === 2 && result.errors.length === 0;
for (const directory of [process.env.DSH_HOME, process.env.DSH_AGENTS_HOME, process.env.HOME]) {
  await rm(directory, { recursive: true, force: true });
}
result.isolatedDataRemoved = true;
result.boundary = 'Official exact Mac Host, Web profile, Standard preset, unmodified native delegation tool/manager, real Settings and working-directory service. Only model metadata resolution and provider output are local controls; the directory changes during the native tool metadata await. No account or paid provider.';
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1;
