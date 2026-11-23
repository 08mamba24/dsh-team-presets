import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogicalSubagents } from '../src/team-addressing.js';
import { readReplacementRecord } from '../src/member-replacement.js';

function fixture(method, duringCall) {
  const caller = {}, root = { id: 'service-drift-root' };
  let service;
  const native = { rootOf: () => root, resolveName: async () => 'lead',
    listDescendants: async () => [], namesOf: () => ({ self: 'lead' }),
    capacityOf: () => ({ running: 0, limit: 8 }), sendMessage: () => 'sent', wait: async () => 'settled' };
  const original = native[method];
  if (duringCall) native[method] = (...args) => { service = {}; return original(...args); };
  service = native;
  const facade = createLogicalSubagents(native, { readRecord: () => readReplacementRecord(),
    fixedRootId: root.id, assertCurrent: () => service });
  return { native, facade, caller, root, drift: () => { service = {}; } };
}

for (const method of ['resolveName', 'listDescendants', 'sendMessage', 'wait']) {
  test(`${method} refuses service replacement while its promise is pending`, async () => {
    const h = fixture(method); let release;
    const ready = new Promise(resolve => { release = resolve; });
    h.native[method] = async () => { await ready; return method === 'listDescendants' ? [] : 'lead'; };
    const pending = h.facade[method](method === 'listDescendants' ? h.root.id : h.caller, 'lead');
    h.drift(); release();
    await assert.rejects(pending, { code: 'TEAM_ADDRESS_HOST_CHANGED' });
  });
}

for (const method of ['capacityOf', 'sendMessage', 'wait']) test(`${method} rejects a captured method after service replacement`, async () => {
  const h = fixture(method); const captured = h.facade[method]; h.drift();
  await assert.rejects(async () => captured(h.caller), { code: 'TEAM_ADDRESS_HOST_CHANGED' });
});

for (const method of ['capacityOf', 'sendMessage', 'wait', 'resolveName', 'listDescendants']) {
  test(`${method} rechecks service identity after the native call settles`, async () => {
    const h = fixture(method, true);
    await assert.rejects(async () => h.facade[method](method === 'listDescendants' ? h.root.id : h.caller, 'lead'),
      { code: 'TEAM_ADDRESS_HOST_CHANGED' });
  });
}
