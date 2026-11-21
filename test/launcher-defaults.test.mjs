import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyLauncher } from '../src/launcher-driver.js';
import { validateLauncherTemplate } from '../src/launcher-config.js';
import { launcherHost } from './fixtures/launcher-host.mjs';

const example = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
const decode = result => ({ ...result, value: JSON.parse(result.text) });
const currentHost = (t, options = {}) => launcherHost(t, async (ctx, config, native, control) => {
  const template = JSON.parse(await readFile(join(config.workspace, '.dsh-team-template.json'), 'utf8'));
  await applyLauncher(ctx, { mode: 'current-session', template, timeoutMs: 3000,
    maxStreams: { implementer: 8, reviewer: 7 } }, native, control, { prepareRoot: async () => {} });
}, { cleanupTimeoutMs: 500, sessionScopedPresets: true, commandName: 'dsh-team', ...options });

test('the bundled template defaults both roles to max without changing their explicit model routes', () => {
  assert.deepEqual(example.members.map(member => member.reasoning_effort), ['max', 'max']);
  assert.deepEqual(validateLauncherTemplate(example).members.map(member => [member.provider, member.model]),
    [['deepseek-account', 'deepseek-flash'], ['deepseek-account', 'deepseek-v4-pro']]);
});

test('configured providers own model ids and effort ids, including equal models for separate roles', async t => {
  const host = await currentHost(t, { memberConfig: {
    implementer: { provider: 'configured-provider', model: 'configured-model', reasoning_effort: 'max' },
    reviewer: { provider: 'configured-provider', model: 'configured-model', reasoning_effort: 'max' },
  } });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'success', result.text);
  assert.equal(host.children.size, 2);
  assert.ok(host.providerCalls.length > 0);
  for (const request of host.providerCalls) {
    assert.equal(request.route.provider, 'configured-provider');
    assert.equal(request.route.model, 'configured-model');
    assert.equal(request.route.reasoningEffort, 'max');
    assert.equal(host.children.get(request.id).agent.options.maxTokens, 1024);
  }
  const before = host.counts();
  assert.equal(decode(await host.invoke('launch')).value.code, 'LAUNCHER_MEMBER_CONFLICT');
  assert.deepEqual(host.counts(), before);
});

test('per-role effort reaches the native spawn and request without a shared low override', async t => {
  const host = await currentHost(t, { memberConfig: {
    implementer: { reasoning_effort: 'max' }, reviewer: { reasoning_effort: 'high' },
  } });
  assert.equal(decode(await host.invoke('launch')).kind, 'success');
  for (const child of host.children.values()) {
    const expected = child.role === 'implementer' ? 'max' : 'high';
    assert.equal(child.agent.model.current().reasoningEffort, expected);
    const requests = host.providerCalls.filter(request => request.id === child.agent.id);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.route.reasoningEffort === expected));
  }
});

test('native unsupported effort and unauthorized routes stop before team mutation or provider calls', async t => {
  for (const unauthorized of [false, true]) {
    const host = await currentHost(t, { unauthorized, memberConfig: {
      implementer: { reasoning_effort: 'max' }, reviewer: { reasoning_effort: 'max' },
    }, resolveCallConfig() {
      throw Object.assign(new Error('UNSUPPORTED_REASONING_EFFORT'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
    } });
    const result = decode(await host.invoke('launch'));
    assert.equal(result.kind, 'error');
    assert.match(result.text, unauthorized ? /SESSION_ROUTE_NOT_AUTHORIZED/ : /UNSUPPORTED_REASONING_EFFORT/);
    assert.deepEqual(host.counts(), { spawnAttempts: 0, wakeCalls: 0, taskCreates: 0, modeWrites: 0, providerCalls: 0 });
  }
});

test('a provider-owned effort is data, while malformed effort remains rejected', () => {
  const input = structuredClone(example);
  input.members[0].reasoning_effort = 'provider-custom-effort';
  input.members[1].provider = 'deepseek-official';
  assert.equal(validateLauncherTemplate(input).members[0].reasoningEffort, 'provider-custom-effort');
  for (const effort of ['', ' max', 'max ', null, 3]) {
    input.members[0].reasoning_effort = effort;
    assert.throws(() => validateLauncherTemplate(input), { code: 'INVALID_MEMBER_EFFORT' });
  }
});
