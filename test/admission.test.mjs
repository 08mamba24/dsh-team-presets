import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, authorize, preflight } from '../src/config.js';
import { createGate } from '../src/gate.js';

export const example = {
  ownedSessionId: 'session-20000000-0000-4000-8000-000000000001',
  workspace: '/tmp/dsh-owned-live-test', runTag: 'live-one-648',
  memberName: 'live-648-implementer', presetId: 'dsh-live-648-implementer',
  personaNonce: 'persona-live-648-abc123', timeoutMs: 60000,
  route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 1024 },
};

test('only a complete immutable bounded plan is admitted', () => {
  assert.equal(parseConfig({}), null);
  const c = parseConfig(example);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.route));
  for (const changed of [{ ...example, route: { ...example.route, maxTokens: 8192 } },
    { ...example, route: { ...example.route, reasoningEffort: 'max' } },
    { ...example, memberName: 'lead' }, { ...example, extra: true }]) {
    assert.throws(() => parseConfig(changed));
  }
});

test('missing or different native Session policy refuses before route metadata I/O', async () => {
  const c = parseConfig(example); let lookups = 0;
  const llm = { resolveCallConfig() { lookups++; throw Error('must not resolve'); } };
  for (const policy of [undefined, null, [], [{ provider: 'deepseek-official', model: 'deepseek-flash' }]]) {
    await assert.rejects(preflight(c, policy, llm, new AbortController().signal), /SESSION_ROUTE_NOT_AUTHORIZED/);
  }
  assert.equal(lookups, 0);
  assert.equal(authorize(c, [{ provider: c.route.provider, model: c.route.model }]), true);
});

test('a native resolver that drops the cap or changes effort cannot admit a child', async () => {
  const c = parseConfig(example), policy = [{ provider: c.route.provider, model: c.route.model }];
  for (const resolved of [{ ...c.route, maxTokens: undefined }, { ...c.route, reasoningEffort: 'max' }, { ...c.route, model: 'other' }]) {
    await assert.rejects(preflight(c, policy, { resolveCallConfig: async () => resolved }, new AbortController().signal), /RESOLVED_CONTROLS_CHANGED/);
  }
  assert.deepEqual(await preflight(c, policy, { resolveCallConfig: async x => x }, new AbortController().signal), c.route);
});

test('dispatch admits exactly one correlated ordinary child stream and preserves unrelated streams', async () => {
  const c = parseConfig(example), gate = createGate(c); let reached = 0;
  const next = async function* () { reached++; yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } }; yield { type: 'finish', reason: 'stop' }; };
  const consume = async x => { for await (const _ of x) {} };
  await consume(gate.hook({ sessionId: 'unrelated' }, next));
  assert.equal(reached, 1);
  gate.track('child-1');
  const request = { ...c.route, sessionId: 'child-1' };
  await assert.rejects(consume(gate.hook({ ...request, purpose: 'title' }, next)), /AUXILIARY_DISABLED/);
  assert.equal(reached, 1);
  const clean = createGate(c); clean.track('child-1');
  await consume(clean.hook(request, next));
  assert.equal(clean.evidence().admissions, 1);
  assert.deepEqual(clean.evidence().usage, { inputTokens: 8, outputTokens: 5 });
  await assert.rejects(consume(clean.hook(request, next)), /REQUEST_ALLOWANCE_USED/);
  await assert.rejects(consume(clean.hook({ ...request, sessionId: c.ownedSessionId }, next)), /ROOT_QUARANTINED/);
  assert.equal(reached, 2);
});

test('causally initiated anonymous streams and control drift cannot reach an adapter', async () => {
  const c = parseConfig(example), gate = createGate(c);gate.track('child-1');
  const consume = async x => { for await (const _ of x) {} };
  const next = () => assert.fail('must not reach adapter');
  await assert.rejects(gate.run(() => consume(gate.hook({}, next))), /UNATTRIBUTED_OWNED_REQUEST/);
  const clean = createGate(c);clean.track('child-1');
  await assert.rejects(consume(clean.hook({ ...c.route, sessionId: 'child-1', maxTokens: 2048 }, next)), /DISPATCH_CONTROLS_CHANGED/);
});
