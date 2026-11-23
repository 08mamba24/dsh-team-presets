import test from 'node:test';
import assert from 'node:assert/strict';
import { bindHostContext, createHostAdapter, inheritHostContext, readAuthorizedRoutes } from '../src/host-adapter.js';

const route = { provider: 'p', model: 'm' };
const root = Symbol('actual-pinned-host-root');
const live = () => createHostAdapter({ version: '0.2.3-alpha.2', Context: { root } });

test('alpha.2 uses the root symbol exported by its pinned Context, without reading string root', () => {
  const actual = { plugin() {} }, ctx = { [root]: actual, get root() { throw new Error('root must not be read'); } };
  assert.equal(live().rootContext(ctx), actual);
  assert.throws(() => createHostAdapter({ version: '0.2.3-alpha.2', Context: {} }),
    { code: 'HOST_ROOT_CONTRACT_UNAVAILABLE' });
});

test('rc.5 retains its root and Session projection contract', () => {
  const session = {}, actual = { plugin() {} };
  const ctx = { root: actual, sessionProjections: { stateOf(value, name) {
    assert.equal(value, session); assert.equal(name, 'subagentModelSelectionPolicy'); return [route, route];
  } }, get() { throw new Error('legacy must not use the live service'); } };
  const adapter = createHostAdapter({ version: '0.2.2-rc.5' }); bindHostContext(ctx, adapter);
  assert.equal(adapter.rootContext(ctx), actual);
  assert.deepEqual(readAuthorizedRoutes(ctx, session), [route, route]);
});

test('live policy is sampled again after revocation, without consulting retained Session events', () => {
  let routes = [route], legacyReads = 0;
  const ctx = { get(name) { assert.equal(name, 'subagentModelSelection'); return { allowedRoutes: () => routes }; },
    sessionProjections: { stateOf() { legacyReads++; return [route]; } } };
  bindHostContext(ctx, live());
  const first = readAuthorizedRoutes(ctx, {}); assert.deepEqual(first, [route]);
  first[0].model = 'edited-copy'; assert.equal(route.model, 'm');
  routes = []; assert.deepEqual(readAuthorizedRoutes(ctx, {}), []);
  routes = undefined; assert.deepEqual(readAuthorizedRoutes(ctx, {}), []);
  assert.equal(legacyReads, 0);
});

test('missing, broken and malformed live services fail closed even when old Session policy authorizes', () => {
  for (const service of [undefined, {}, { allowedRoutes() { throw new Error('read failed'); } },
    { allowedRoutes: () => ({ routes: [route] }) }, { allowedRoutes: () => [null] },
    { allowedRoutes: () => [route, route] }]) {
    let legacyReads = 0;
    const ctx = { get: () => service, sessionProjections: { stateOf() { legacyReads++; return [route]; } } };
    bindHostContext(ctx, live());
    assert.throws(() => readAuthorizedRoutes(ctx, {}), { code: 'HOST_MODEL_POLICY_UNAVAILABLE' });
    assert.equal(legacyReads, 0);
  }
});

test('an unbound context or unverified replacement adapter cannot choose legacy authorization', () => {
  const ctx = { sessionProjections: { stateOf: () => [route] } };
  assert.throws(() => readAuthorizedRoutes(ctx, {}), { code: 'HOST_MODEL_POLICY_UNBOUND' });
  assert.throws(() => bindHostContext(ctx, { allowedRoutes: () => [route] }), { code: 'HOST_ADAPTER_UNVERIFIABLE' });
  const adapter = live(); bindHostContext(ctx, adapter); bindHostContext(ctx, adapter);
  assert.throws(() => bindHostContext(ctx, live()), { code: 'HOST_ADAPTER_CHANGED' });
  assert.throws(() => createHostAdapter({ version: 'next' }), { code: 'HOST_ADAPTER_VERSION_UNSUPPORTED' });
});

test('a per-root child plugin inherits only an explicitly bound Host contract', () => {
  const parent = {}, child = { get: () => ({ allowedRoutes: () => [route] }) };
  assert.throws(() => inheritHostContext(parent, child), { code: 'HOST_MODEL_POLICY_UNBOUND' });
  bindHostContext(parent, live()); inheritHostContext(parent, child);
  assert.deepEqual(readAuthorizedRoutes(child, {}), [route]);
  assert.throws(() => readAuthorizedRoutes(Object.create(child), {}), { code: 'HOST_MODEL_POLICY_UNBOUND' });
});
