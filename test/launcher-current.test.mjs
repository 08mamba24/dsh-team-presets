import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyLauncher } from '../src/launcher-driver.js';
import { applyCurrentLauncher } from '../src/launcher-current.js';
import { launcherHost, CONTROL } from './fixtures/launcher-host.mjs';
import { nativeEffectOwner } from './fixtures/native-effect-owner.mjs';

const currentHost = (t, options = {}) => launcherHost(t, async (ctx, config, native, control) => {
  const template = JSON.parse(await readFile(join(config.workspace, '.dsh-team-template.json'), 'utf8'));
  await applyLauncher(ctx, { mode: 'current-session', template, timeoutMs: 3000,
    maxStreams: { implementer: 8, reviewer: 7 } }, native, control, { prepareRoot: async () => {} });
}, { cleanupTimeoutMs: 500, ...options, sessionScopedPresets: true, commandName: 'dsh-team' });
const decode = result => ({ ...result, value: JSON.parse(result.text) });

test('managed root preparation finishes before commands can start member work and failures stop dispatch', async t => {
  const prepared = [];
  let rejectPreparation = false;
  const host = await launcherHost(t, async (ctx, config, native, control) => {
    const template = JSON.parse(await readFile(join(config.workspace, '.dsh-team-template.json'), 'utf8'));
    await applyCurrentLauncher(ctx, { mode: 'current-session', template }, native, control, {
      readTemplate: () => template,
      async prepareRoot(agent) {
        assert.equal(ctx.agents.get(agent.id), agent);
        assert.equal(ctx.settings.describe().find(row => row.ns === 'dsh-native-current-team')
          .value.replacementRecords[agent.id].baseBinding !== undefined, true);
        prepared.push(agent.id);
        if (rejectPreparation) throw Object.assign(new Error('ROOT_ADDRESS_INSTALL_FAILED'), { code: 'ROOT_ADDRESS_INSTALL_FAILED' });
      },
    });
  }, { sessionScopedPresets: true, commandName: 'dsh-team' });
  assert.equal(decode(await host.invoke('plan')).kind, 'success');
  assert.deepEqual(prepared, [host.root.id]);
  rejectPreparation = true;
  assert.equal(decode(await host.invoke('launch')).value.code, 'ROOT_ADDRESS_INSTALL_FAILED');
  assert.deepEqual(prepared, [host.root.id, host.root.id]);
  assert.equal(host.counts().providerCalls, 0);
  assert.equal(host.catalog.size, 0);
});

test('live template defaults affect unbound roots while existing plans and Presets retain their snapshot', async t => {
  const first = await launcherHost(t, async () => {});
  const second = await launcherHost(t, async () => {}, { sessionId: 'session-99999999-9999-4999-8999-999999999999' });
  const hosts = [first, second], commands = new Map();
  const ownerOf = id => hosts.find(host => host.root.id === id);
  let value = structuredClone(first.template);
  const ctx = { ...first.ctx,
    agents: { get: id => first.agents.get(id) ?? second.agents.get(id), list: () => hosts.map(host => host.root) },
    commands: { register(spec) { commands.set(spec.name, spec); return () => commands.delete(spec.name); } },
    subagents: { ...first.ctx.subagents, listDescendants(id, signal) { return ownerOf(id).ctx.subagents.listDescendants(id, signal); } },
    agentPresets: { ...first.ctx.agentPresets,
      register(spec) { return ownerOf(spec.plugins[1].config.ownedSessionId).ctx.agentPresets.register(spec); } },
    plugin(module) { return Promise.resolve(module.apply(ctx)); },
  };
  const control = await applyCurrentLauncher(ctx, { mode: 'current-session', template: first.template }, { apply() {} }, CONTROL,
    { readTemplate: () => value, prepareRoot: async () => {} });
  const plan = async host => decode(await commands.get('dsh-team').handler({ agent: host.root, rawInput: 'plan', attachments: [], signal: new AbortController().signal }));
  const before = await plan(first);
  const presets = structuredClone([...first.presets.values()]);
  value.members[0].persona_prompt = 'MARK_NEW_DEFAULT';
  assert.equal(control.hasBinding(first.root.id), true);
  assert.equal(control.hasBinding(second.root.id), false);
  assert.equal((await plan(first)).value.templateFingerprint, before.value.templateFingerprint);
  assert.deepEqual([...first.presets.values()], presets);
  assert.equal((await plan(second)).kind, 'success');
  assert.ok(JSON.stringify([...second.presets.values()]).includes('MARK_NEW_DEFAULT'));
  assert.equal(first.counts().providerCalls + second.counts().providerCalls, 0);
  value = undefined;
  assert.notEqual(control.defaultTemplate().members[0].persona_prompt, 'MARK_NEW_DEFAULT');
});

test('current-session configuration starts the invoking root without a configured Session ID', async t => {
  const host = await currentHost(t);
  const planned = decode(await host.invoke('plan'));
  assert.equal(planned.kind, 'success', planned.text);
  assert.equal(host.counts().providerCalls, 0);
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'success', result.text);
  assert.equal(result.value.ok, true);
  assert.equal(host.catalog.size, 2);
  assert.deepEqual(result.value.tasks.map(task => task.status), ['completed', 'completed']);
  assert.ok(result.value.members.every(member => member.agentPreset.startsWith('dsh-current-')));
  const before = host.counts();
  const repeated = decode(await host.invoke('launch'));
  assert.equal(repeated.kind, 'error');
  assert.equal(repeated.value.code, 'LAUNCHER_MEMBER_CONFLICT');
  assert.deepEqual(host.counts(), before);
  assert.equal(host.catalog.size, 2);
  const restored = decode(await host.invoke('restore'));
  assert.equal(restored.kind, 'success', restored.text);
  assert.equal(host.board.isEnabled(host.root), false);
});

test('the same generic configuration also starts a different root and isolates its Preset IDs', async t => {
  const first = await currentHost(t);
  const second = await currentHost(t, { sessionId: 'session-99999999-9999-4999-8999-999999999999' });
  assert.equal(decode(await first.invoke('launch')).kind, 'success');
  assert.equal(decode(await second.invoke('launch')).kind, 'success');
  assert.equal(new Set([...first.presets.keys(), ...second.presets.keys()]).size, 4);
  for (const host of [first, second]) for (const preset of host.presets.values()) {
    assert.equal(preset.plugins[1].config.ownedSessionId, host.root.id);
    assert.equal(preset.plugins[1].config.replacementOwner, 'dsh-native-current-team');
  }
});

test('current-session admission rejects a detached or child invoker before creating presets or model calls', async t => {
  const host = await currentHost(t);
  const detached = { ...host.root, id: 'session-99999999-9999-4999-8999-999999999999' };
  assert.equal(decode(await host.invoke('launch', { agent: detached })).value.code, 'WRONG_AGENT');
  host.root.session.header.origin = 'subagent';
  assert.equal(decode(await host.invoke('launch')).value.code, 'WRONG_AGENT');
  assert.equal(host.presets.size, 0);
  assert.equal(host.counts().providerCalls, 0);
});

test('current-session mode retains native route authorization and partial-failure cleanup', async t => {
  const denied = await currentHost(t, { unauthorized: true });
  assert.equal(decode(await denied.invoke('launch')).kind, 'error');
  assert.equal(denied.counts().spawnAttempts, 0);
  const partial = await currentHost(t, { failSecondCreate: true });
  const result = decode(await partial.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(partial.counts().spawnAttempts, 2, 'exercise a real partial creation in the native fixture');
  assert.equal(partial.children.size, 1);
  assert.equal(partial.board.isEnabled(partial.root), false);
  assert.ok([...partial.children.values()].every(child => child.ended));
});

test('current-session commands reject cancellation and binding drift without another model call', async t => {
  const host = await currentHost(t);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(decode(await host.invoke('launch', { signal: aborted.signal })).kind, 'error');
  assert.equal(host.presets.size, 0);
  assert.equal(decode(await host.invoke('plan')).kind, 'success');
  await host.ctx.workingDirectory.set(host.root, '/different-workspace');
  assert.equal(decode(await host.invoke('launch')).value.code, 'CURRENT_SESSION_BINDING_CHANGED');
  assert.equal(host.counts().providerCalls, 0);
});

test('a native directory change before the first command creates children in the effective directory', async t => {
  const host = await currentHost(t);
  const directory = join(host.config.workspace, 'changed');
  await mkdir(directory);
  await host.ctx.workingDirectory.set(host.root, directory);
  assert.equal(host.root.session.header.cwd, host.config.workspace, 'native cd preserves the original header');
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'success', result.text);
  assert.equal(host.children.size, 2);
  for (const child of host.children.values()) {
    assert.equal(child.agent.session.header.cwd, host.config.workspace, 'native child metadata inherits the initial parent directory');
    assert.equal(host.ctx.workingDirectory.get(child.agent.session), directory);
    assert.equal(child.ended, true);
  }
  assert.deepEqual(result.value.tasks.map(task => task.status), ['completed', 'completed']);
  const before = host.counts();
  assert.equal(decode(await host.invoke('launch')).value.code, 'LAUNCHER_MEMBER_CONFLICT');
  assert.deepEqual(host.counts(), before);
  assert.equal(decode(await host.invoke('restore')).kind, 'success');
  assert.equal(host.board.isEnabled(host.root), false);
});

test('partial creation after native cd drains the inherited-header child and restores Team mode', async t => {
  const host = await currentHost(t, { failSecondCreate: true });
  const directory = join(host.config.workspace, 'changed');
  await mkdir(directory);
  await host.ctx.workingDirectory.set(host.root, directory);
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(host.counts().spawnAttempts, 2, result.text);
  assert.equal(host.children.size, 1);
  assert.ok([...host.children.values()].every(child => child.ended));
  assert.equal(host.board.isEnabled(host.root), false, result.text);
  await host.dispose();
  assert.equal(host.presets.size, 0);
});

test('an incorrect effective child directory is rejected but an ended idle child can drain', async t => {
  const host = await currentHost(t, { childWorkspaceDrift: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.operationFailure, 'CHILD_CONFIGURATION_CHANGED', result.text);
  assert.ok([...host.children.values()].every(child => child.ended && child.agent.status === 'idle'));
  assert.equal(host.counts().providerCalls, 0);
  assert.equal(host.board.isEnabled(host.root), false, result.text);
  await host.dispose();
  assert.equal(host.presets.size, 0);
});

test('reload restores retained Presets and prepares live or resumed roots without recreating members', async t => {
  const host = await currentHost(t);
  assert.equal(decode(await host.invoke('launch')).kind, 'success');
  const before = host.counts();
  const ids = [...host.catalog.keys()];
  await host.dispose();
  assert.equal(host.presets.size, 0);
  const owner = nativeEffectOwner();
  t.after(() => owner.dispose());
  const ctx = { ...host.ctx, effect: owner.effect,
    on: (name, fn) => owner.on(host.hooks, name, fn),
    plugin(module) { return Promise.resolve(module.apply(ctx)); },
  };
  const prepared = [];
  await applyLauncher(ctx, { mode: 'current-session', template: host.template }, { apply() {} }, CONTROL, {
    readRecords: () => ctx.settings.describe().find(row => row.ns === 'dsh-native-current-team').value.replacementRecords,
    prepareRoot: async agent => { prepared.push(agent); },
  });
  assert.equal(host.presets.size, 2, 'durable binding restores Presets before member continuation');
  assert.deepEqual(prepared, [host.root], 'reload prepares an already registered root before returning');
  for (const listener of host.hooks.get('agent/created') ?? []) await listener({ agent: host.root, source: 'resume' });
  assert.deepEqual(prepared, [host.root, host.root], 'serial creation also prepares cold root resume');
  const plan = decode(await host.invoke('plan'));
  assert.equal(plan.kind, 'success', plan.text);
  assert.equal(host.presets.size, 2);
  assert.equal(decode(await host.invoke('launch')).value.code, 'LAUNCHER_MEMBER_CONFLICT');
  assert.equal(decode(await host.invoke('restore')).kind, 'error', 'the old in-memory restore grant is not reconstructed');
  assert.deepEqual(host.counts(), before);
  assert.deepEqual([...host.catalog.keys()], ids);
});

test('one command registration plans two registered roots independently', async t => {
  const first = await launcherHost(t, async () => {});
  const second = await launcherHost(t, async () => {}, { sessionId: 'session-99999999-9999-4999-8999-999999999999' });
  const hosts = [first, second], commands = new Map();
  const ownerOf = id => hosts.find(host => host.root.id === id);
  const ctx = { ...first.ctx,
    agents: { get: id => first.agents.get(id) ?? second.agents.get(id), list: () => hosts.map(host => host.root) },
    commands: { register(spec) { assert.equal(commands.has(spec.name), false); commands.set(spec.name, spec);
      return () => commands.delete(spec.name); } },
    subagents: { ...first.ctx.subagents,
      listDescendants(id, signal) { return ownerOf(id).ctx.subagents.listDescendants(id, signal); } },
    agentPresets: { ...first.ctx.agentPresets,
      register(spec) { return ownerOf(spec.plugins[1].config.ownedSessionId).ctx.agentPresets.register(spec); } },
    plugin(module) { return Promise.resolve(module.apply(ctx)); },
  };
  await applyLauncher(ctx, { mode: 'current-session', template: first.template }, { apply() {} }, CONTROL,
    { prepareRoot: async () => {} });
  assert.deepEqual([...commands.keys()], ['dsh-team']);
  for (const host of hosts) {
    const result = decode(await commands.get('dsh-team').handler({ agent: host.root, rawInput: 'plan',
      attachments: [], signal: new AbortController().signal }));
    assert.equal(result.kind, 'success', result.text);
    assert.ok(result.value.plan.members.every(member => member.action === 'create'));
    assert.equal(host.presets.size, 2);
    assert.equal(host.counts().providerCalls, 0);
  }
  assert.equal(new Set(hosts.flatMap(host => [...host.presets.keys()])).size, 4);
});
