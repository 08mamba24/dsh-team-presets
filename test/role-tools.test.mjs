import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultWorkTemplate, roleToolCatalog } from '../src/role-tools.js';

const bundled = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));

test('unsaved work defaults use registered tools including the available Windows shell, without changing the example', () => {
  const definitions = ['read', 'write', 'grep', 'pwsh', 'skill'].map(name => ({ name, description: name }));
  const ctx = { tools: { definitions: () => definitions } };
  const before = structuredClone(bundled);
  const next = defaultWorkTemplate(ctx, {}, bundled);
  for (const member of next.members) {
    assert.ok(member.native_tool_allowlist.includes('read'));
    assert.ok(member.native_tool_allowlist.includes('write'));
    assert.ok(member.native_tool_allowlist.includes('pwsh'));
    assert.ok(member.native_tool_allowlist.includes('send_message'));
    assert.equal(member.native_tool_allowlist.includes('bash'), false, 'an absent shell must not be invented');
  }
  assert.deepEqual(bundled, before);
});

test('a root-local or root-shadowed definition is not advertised as a shared child capability', () => {
  const global = [{ name: 'read', description: 'shared' }, { name: 'write', description: 'shared' }];
  const local = [global[0], { name: 'write', description: 'root shadow' }, { name: 'root_only', description: 'local' }];
  const ctx = { tools: { definitions: scope => scope === undefined ? global : local } };
  const names = roleToolCatalog(ctx, {}).map(tool => tool.name);
  assert.ok(names.includes('read'));
  assert.equal(names.includes('write'), false); assert.equal(names.includes('root_only'), false);
  assert.ok(names.includes('wait_agent'), 'native control Preset tools are declared separately from the root view');
});
