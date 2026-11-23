import assert from 'node:assert/strict';

/** Configure only the acceptance profile, through the Host's real policy owner. */
export async function setNativeModelRoutes(ctx, session, version, routes) {
  if (version === '0.2.3-alpha.2') {
    const ns = 'subagent-model-selection-settings';
    const row = () => ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === ns);
    const before = row();
    assert.ok(before, 'official live model-selection settings must be active');
    await ctx.settings.mutate(ns, [
      { op: 'set', path: ['enabled'], value: routes !== undefined },
      { op: 'set', path: ['allowedModels'], value: routes ?? [] },
    ], before.revision);
    const after = row();
    assert.ok(after);
    assert.equal(after.value.enabled, routes !== undefined);
    assert.deepEqual(after.value.allowedModels, routes ?? []);
    assert.deepEqual(ctx.get('subagentModelSelection').allowedRoutes(), routes);
  } else {
    assert.ok(['0.2.2-rc.2', '0.2.2-rc.5'].includes(version), 'unreviewed fixture Host');
    session.append('subagent/model-selection-policy', { allowedModels: routes ?? [] });
    assert.deepEqual(ctx.sessionProjections.stateOf(session, 'subagentModelSelectionPolicy'), routes ?? []);
  }
}

/** Read the native result without discarding its real capacity envelope. */
export function nativeAgentRows(value) {
  if (Array.isArray(value)) return value;
  assert.deepEqual(Object.keys(value).sort(), ['agents', 'limit', 'running']);
  assert.ok(Number.isSafeInteger(value.running) && value.running >= 0);
  assert.ok(Number.isSafeInteger(value.limit) && value.limit > 0);
  assert.ok(Array.isArray(value.agents));
  return value.agents;
}
