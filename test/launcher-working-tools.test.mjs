import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyCurrentLauncher } from '../src/launcher-current.js';
import { launcherHost } from './fixtures/launcher-host.mjs';

const files = () => [
  { name: 'read', description: 'Read a fixture workspace file', execute: args => readFile(args.file_path, 'utf8') },
  { name: 'write', description: 'Write a fixture workspace file', async execute(args) {
    await writeFile(args.file_path, args.content); return { written: true };
  } },
];
async function host(t, options) {
  return launcherHost(t, async (ctx, config, native, control) => {
    const template = JSON.parse(await readFile(join(config.workspace, '.dsh-team-template.json'), 'utf8'));
    await applyCurrentLauncher(ctx, { mode: 'current-session', template,
      maxStreams: { implementer: 8, reviewer: 7 } }, native, control, { prepareRoot: async () => {} });
  }, { workTools: files(), ...options, commandName: 'dsh-team', sessionScopedPresets: true });
}
const result = value => JSON.parse(value.text);

test('configured read/write tools execute during native-lifecycle fixture startup with exact per-role schemas', async t => {
  const f = await host(t, {
    memberConfig: { implementer: { native_tool_allowlist: ['read', 'write'] }, reviewer: { native_tool_allowlist: ['read'] } },
    workCalls: (role, workspace) => [{ name: 'read', arguments: { file_path: join(workspace, 'input.txt') } },
      ...role === 'implementer' ? [{ name: 'write', arguments: { file_path: join(workspace, 'output.txt'), content: 'verified work' } }] : []],
  });
  await writeFile(join(f.config.workspace, 'input.txt'), 'source evidence');
  const launched = result(await f.invoke('launch'));
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(await readFile(join(f.config.workspace, 'output.txt'), 'utf8'), 'verified work');
  assert.equal(f.bodyCalls.filter(call => call.name === 'read').length, 2);
  for (const call of f.providerCalls) assert.deepEqual([...call.tools].sort(),
    call.role === 'implementer' ? ['read', 'write'] : ['read']);
  assert.equal(launched.members.every(member => member.scopeDenials.length === 0), true);
});

test('a selected but unregistered work tool is refused before model metadata, mode writes or member creation', async t => {
  const f = await host(t, { pendingStartup: true,
    memberConfig: { implementer: { native_tool_allowlist: ['missing_work_tool'] } } });
  const launched = result(await f.invoke('launch'));
  assert.equal(launched.code, 'TEAM_TOOL_UNAVAILABLE');
  assert.equal(f.preflights.length, 0); assert.equal(f.providerCalls.length, 0); assert.equal(f.children.size, 0);
  assert.equal(f.writes.length, 0);
});

test('a globally registered write tool outside the role list cannot reach its body', async t => {
  const f = await host(t, {
    memberConfig: { implementer: { native_tool_allowlist: ['read'] }, reviewer: { native_tool_allowlist: ['read'] } },
    workCalls: (role, workspace) => role === 'implementer'
      ? [{ name: 'write', arguments: { file_path: join(workspace, 'forbidden.txt'), content: 'must not write' } }] : [],
  });
  assert.equal((await f.invoke('launch')).kind, 'error');
  assert.equal(f.bodyCalls.some(call => call.name === 'write'), false);
  await assert.rejects(readFile(join(f.config.workspace, 'forbidden.txt')), { code: 'ENOENT' });
});

test('the launcher preserves a downstream native permission refusal for a selected write tool', async t => {
  const f = await host(t, {
    memberConfig: { implementer: { native_tool_allowlist: ['write'] }, reviewer: { native_tool_allowlist: [] } },
    nativeDenyTool: 'write',
    workCalls: (role, workspace) => role === 'implementer'
      ? [{ name: 'write', arguments: { file_path: join(workspace, 'denied.txt'), content: 'must not write' } }] : [],
  });
  assert.equal((await f.invoke('launch')).kind, 'error');
  assert.equal(f.bodyCalls.some(call => call.name === 'write'), false);
  await assert.rejects(readFile(join(f.config.workspace, 'denied.txt')), { code: 'ENOENT' });
});

test('root tool withdrawal during awaited metadata preflight stops before startup mutation', async t => {
  let revoked = false;
  const f = await host(t, {
    pendingStartup: true,
    memberConfig: { implementer: { native_tool_allowlist: ['write'] }, reviewer: { native_tool_allowlist: [] } },
    toolDefinitions: (scope, definitions) => definitions.filter(tool => !(revoked && scope?.session.header.origin !== 'subagent' && scope !== undefined && tool.name === 'write')),
    async resolveCallConfig(route) { await new Promise(resolve => setImmediate(resolve)); revoked = true; return route; },
  });
  const launched = result(await f.invoke('launch'));
  assert.equal(launched.code, 'TEAM_TOOL_UNAVAILABLE', JSON.stringify(launched));
  assert.equal(f.writes.length, 0); assert.equal(f.children.size, 0); assert.equal(f.bodyCalls.length, 0);
});

for (const change of ['root-deny', 'root-shadow', 'shared-remove', 'shared-replace', 'child-shadow']) {
  test(`native approval does not preserve stale work authority after ${change}`, async t => {
    let changed = false;
    const replacement = { name: 'write', description: 'a different registered capability' };
    const f = await host(t, {
      memberConfig: { implementer: { native_tool_allowlist: ['write'] }, reviewer: { native_tool_allowlist: [] } },
      toolDefinitions(scope, definitions) {
        if (!changed) return definitions;
        const root = scope !== undefined && scope.session.header.origin !== 'subagent';
        const child = scope?.session.header.origin === 'subagent';
        if (change === 'shared-remove' || change === 'root-deny' && root) return definitions.filter(tool => tool.name !== 'write');
        if (change === 'shared-replace' || change === 'root-shadow' && root || change === 'child-shadow' && child) {
          return definitions.map(tool => tool.name === 'write' ? replacement : tool);
        }
        return definitions;
      },
      askWorkTool: 'write',
      async onApproval() { await new Promise(resolve => setImmediate(resolve)); changed = true; },
      workCalls: (role, workspace) => role === 'implementer'
        ? [{ name: 'write', arguments: { file_path: join(workspace, 'revoked.txt'), content: 'must not write' } }] : [],
    });
    const launched = result(await f.invoke('launch'));
    assert.equal(launched.code, 'TEAM_TOOL_FAILED', JSON.stringify(launched));
    assert.ok(f.order.includes('native-approval-allowed'));
    const implementer = [...f.children.values()].find(child => child.role === 'implementer');
    assert.ok(implementer.history.some(message => message.role === 'tool'
      && message.content.some(block => block.text === 'TEAM_ROOT_TOOL_AUTHORITY_CHANGED')));
    assert.equal(f.bodyCalls.some(call => call.name === 'write'), false);
    await assert.rejects(readFile(join(f.config.workspace, 'revoked.txt')), { code: 'ENOENT' });
  });
}

test('root Preset-local tools bridge into independent role scopes and execute exact selected bodies', async t => {
  const f = await host(t, {
    workTools: [], presetTools: files(),
    memberConfig: { implementer: { native_tool_allowlist: ['read', 'write'] }, reviewer: { native_tool_allowlist: ['read'] } },
    workCalls: (role, workspace) => [{ name: 'read', arguments: { file_path: join(workspace, 'input.txt') } },
      ...role === 'implementer' ? [{ name: 'write', arguments: { file_path: join(workspace, 'output.txt'), content: 'Preset work' } }] : []],
  });
  assert.equal(f.ctx.tools.definitions().some(tool => tool.name === 'read'), false);
  await writeFile(join(f.config.workspace, 'input.txt'), 'standard Preset evidence');
  const launched = result(await f.invoke('launch'));
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(await readFile(join(f.config.workspace, 'output.txt'), 'utf8'), 'Preset work');
  assert.equal(f.bodyCalls.filter(call => call.name === 'read').length, 2);
});
