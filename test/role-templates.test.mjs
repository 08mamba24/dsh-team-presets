import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { listRoleTemplates, resolveRoleTemplate, validateCustomRoleTemplates } from '../src/role-templates.js';
import { validateLauncherTemplate } from '../src/launcher-config.js';

const validCustom = () => [{ id: 'docs-writer', description: '文档模板：整理与核对面向使用者的文档',
  persona_prompt: '你是 docs-writer。核对文档与真实行为后再交付。', prompt: '就绪后等待任务书。',
  native_tool_allowlist: ['write', 'read'] }];

test('six built-in templates exist with stable ids and the exact five-field record shape', () => {
  const rows = listRoleTemplates();
  assert.deepEqual(rows.map(row => row.id), ['architect', 'implementer', 'reviewer', 'tester', 'researcher', 'designer']);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['description', 'id', 'native_tool_allowlist', 'persona_prompt', 'prompt']);
    assert.equal('provider' in row, false);
    assert.equal('model' in row, false);
    assert.ok(row.description.length > 0 && row.persona_prompt.length > 0 && row.prompt.length > 0);
    assert.ok(row.native_tool_allowlist.includes('send_message') && row.native_tool_allowlist.includes('team_task_get'));
  }
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  for (const id of ['implementer', 'tester']) {
    assert.ok(byId[id].native_tool_allowlist.includes('bash'), id);
    assert.ok(byId[id].native_tool_allowlist.includes('pwsh'), id);
  }
  for (const id of ['architect', 'reviewer', 'researcher', 'designer']) {
    assert.equal(byId[id].native_tool_allowlist.includes('bash'), false, id);
  }
});

test('returned templates are copies; mutating an instance never pollutes later reads', () => {
  const first = resolveRoleTemplate('implementer');
  first.prompt = 'MUTATED';
  first.native_tool_allowlist.push('str_replace_editor');
  const second = resolveRoleTemplate('implementer');
  assert.notEqual(second.prompt, 'MUTATED');
  assert.equal(second.native_tool_allowlist.includes('str_replace_editor'), false);
  assert.deepEqual(listRoleTemplates()[1], second);
});

test('custom templates join listing and resolution with sorted exact tool lists', () => {
  const custom = validCustom();
  const rows = listRoleTemplates(custom);
  assert.equal(rows.length, 7);
  assert.equal(rows.at(-1).id, 'docs-writer');
  assert.deepEqual(resolveRoleTemplate('docs-writer', custom).native_tool_allowlist, ['read', 'write']);
  const bare = [{ id: 'plain', description: '零工作工具模板', persona_prompt: '你是 plain。等待任务后仅按指示协作。',
    prompt: '等待任务。', native_tool_allowlist: [] }];
  assert.deepEqual(resolveRoleTemplate('plain', bare).native_tool_allowlist, []);
});

test('a custom template is rejected when its persona is missing or blank, never stored with an implicit default', () => {
  assert.throws(() => validateCustomRoleTemplates([{ id: 'x1', description: 'd', prompt: 'p', native_tool_allowlist: [] }]),
    { code: 'INVALID_ROLE_TEMPLATE_PERSONA' });
  assert.throws(() => validateCustomRoleTemplates([{ ...validCustom()[0], persona_prompt: '   ' }]),
    { code: 'INVALID_ROLE_TEMPLATE_PERSONA' });
  assert.throws(() => resolveRoleTemplate('docs-writer', [{ id: 'x1', description: 'd', prompt: 'p', native_tool_allowlist: [] }]),
    { code: 'INVALID_ROLE_TEMPLATE_PERSONA' });
});

test('a resolved custom template fills a launcher example member and passes the real member validation', async () => {
  const example = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
  const custom = [{ id: 'frontend-dev', description: '前端实现模板：按任务书推进并交付可验证结果',
    persona_prompt: '你是 frontend-dev。使用实际可用工具实现，并把证据写回任务板。',
    prompt: '你已加入团队。确认就绪后等待明确任务。',
    native_tool_allowlist: ['read', 'write', 'edit', 'glob', 'grep', 'send_message', 'team_task_get', 'team_task_update'] }];
  const row = resolveRoleTemplate('frontend-dev', custom);
  const member = example.members[0];
  for (const key of ['description', 'persona_prompt', 'prompt', 'native_tool_allowlist']) member[key] = row[key];
  assert.doesNotThrow(() => validateLauncherTemplate(example));
  const blank = structuredClone(example);
  blank.members[0].persona_prompt = '';
  assert.throws(() => validateLauncherTemplate(blank), { code: 'INVALID_MEMBER_PERSONA' });
});

test('validation normalizes and freezes without mutating the caller input', () => {
  const custom = validCustom();
  const frozen = validateCustomRoleTemplates(custom);
  assert.deepEqual(frozen[0].native_tool_allowlist, ['read', 'write']);
  assert.deepEqual(custom[0].native_tool_allowlist, ['write', 'read']);
  assert.equal(Object.isFrozen(frozen), true);
});

test('unknown, malformed and reserved ids are rejected explicitly', () => {
  assert.throws(() => resolveRoleTemplate('no-such-role'), { code: 'UNKNOWN_ROLE_TEMPLATE' });
  assert.throws(() => resolveRoleTemplate('Review-er'), { code: 'INVALID_ROLE_TEMPLATE_ID' });
  assert.throws(() => resolveRoleTemplate('a'.repeat(33)), { code: 'INVALID_ROLE_TEMPLATE_ID' });
  assert.throws(() => validateCustomRoleTemplates([{ ...validCustom()[0], id: 'reviewer' }]), { code: 'RESERVED_ROLE_TEMPLATE_ID' });
  assert.throws(() => validateCustomRoleTemplates([validCustom()[0], { ...validCustom()[0], description: 'x' }]),
    { code: 'DUPLICATE_ROLE_TEMPLATE_ID' });
});

test('even when resolving a built-in id, malformed custom data fails closed first', () => {
  assert.throws(() => resolveRoleTemplate('architect', [{ id: 'bad', description: 'd', prompt: 'p', persona_prompt: 'pp' }]),
    { code: 'INVALID_ROLE_TEMPLATE_TOOLS' });
});

test('custom records must be exact five-field objects with usable text', () => {
  assert.throws(() => validateCustomRoleTemplates(undefined), { code: 'INVALID_ROLE_TEMPLATES' });
  assert.throws(() => validateCustomRoleTemplates({}), { code: 'INVALID_ROLE_TEMPLATES' });
  assert.throws(() => validateCustomRoleTemplates(new Proxy([], {})), { code: 'INVALID_ROLE_TEMPLATES' });
  assert.throws(() => validateCustomRoleTemplates([{ ...validCustom()[0], provider: 'deepseek-account' }]),
    { code: 'INVALID_ROLE_TEMPLATE' });
  assert.throws(() => validateCustomRoleTemplates([{ id: 'x1', description: '  ', persona_prompt: 'pp', prompt: 'p', native_tool_allowlist: [] }]),
    { code: 'INVALID_ROLE_TEMPLATE_DESCRIPTION' });
  assert.throws(() => validateCustomRoleTemplates([{ id: 'x1', description: 'd', persona_prompt: 'pp', native_tool_allowlist: [] }]),
    { code: 'INVALID_ROLE_TEMPLATE_PROMPT' });
  assert.throws(() => validateCustomRoleTemplates([{ id: 'x1', description: 'd', persona_prompt: 7, prompt: 'p', native_tool_allowlist: [] }]),
    { code: 'INVALID_ROLE_TEMPLATE_PERSONA' });
});

test('managed, recursive and plugin-control tool names cannot enter a template allowlist', () => {
  for (const bad of ['subagent', 'spawn_agent', 'run_code', 'plugin_manager', 'dsh_team_configure', 'team_launch', '']) {
    assert.throws(() => validateCustomRoleTemplates([{ ...validCustom()[0], native_tool_allowlist: [bad] }]),
      { code: 'UNSUPPORTED_ROLE_TEMPLATE_TOOL' }, bad);
  }
  assert.throws(() => validateCustomRoleTemplates([{ ...validCustom()[0], native_tool_allowlist: ['read', 'read'] }]),
    { code: 'DUPLICATE_ROLE_TEMPLATE_TOOL' });
  assert.throws(() => validateCustomRoleTemplates([{ ...validCustom()[0], native_tool_allowlist: 'read' }]),
    { code: 'INVALID_ROLE_TEMPLATE_TOOLS' });
});

test('collaboration tool names stay selectable and an empty list means intentionally no work tools', () => {
  const rows = [{ id: 'tiny', description: 'd', persona_prompt: 'pp', prompt: 'p', native_tool_allowlist: ['wait_agent', 'send_message'] }];
  assert.deepEqual(validateCustomRoleTemplates(rows)[0].native_tool_allowlist, ['send_message', 'wait_agent']);
});
