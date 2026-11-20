import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLauncherTemplate, launcherTemplateFingerprint } from '../src/launcher-template.js';

const example = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const rejects = (raw, code) => assert.throws(() => parseLauncherTemplate(raw), error => {
  assert.equal(error.code, code); assert.equal(error.message, code); return true;
});

test('the delivered template normalizes without conflating launch prompt, persona or role-specific tools', () => {
  const input = clone(example), value = parseLauncherTemplate(input);
  assert.equal(value.templateSchema, 'dsh-team-template/1');
  assert.equal(value.templateMeta.liveVerified, false);
  assert.equal(value.members[0].prompt, example.members[0].prompt);
  assert.equal(value.members[0].personaPrompt, example.members[0].persona_prompt);
  assert.notEqual(value.members[0].prompt, value.members[0].personaPrompt);
  assert.ok(value.members[0].nativeToolAllowlist.includes('send_message'));
  assert.ok(!value.members[0].nativeToolAllowlist.includes('wait_agent'));
  assert.ok(value.members[1].nativeToolAllowlist.includes('wait_agent'));
  assert.ok(!value.members[1].nativeToolAllowlist.includes('send_message'));
  input.members[0].prompt = 'changed outside the normalized object';
  input.members[0].native_tool_allowlist.push('bash');
  assert.equal(value.members[0].prompt, example.members[0].prompt);
  for (const item of [value, value.templateMeta, value.members, value.members[0], value.members[0].nativeToolAllowlist,
    value.seedTasks, value.seedTasks[1], value.seedTasks[1].blockedBy]) assert.ok(Object.isFrozen(item));
});

test('optional persona, preset and capabilities stay absent instead of acquiring defaults', () => {
  const input = clone(example);
  delete input.max_members; delete input.template_meta; delete input.seed_tasks;
  for (const member of input.members) {
    delete member.persona_prompt; delete member.agent_preset; delete member.native_tool_allowlist; delete member.reasoning_effort;
  }
  const value = parseLauncherTemplate(input);
  assert.equal(value.maxMembers, 4); assert.deepEqual(value.seedTasks, []);
  for (const member of value.members) for (const key of ['personaPrompt', 'agentPreset', 'nativeToolAllowlist', 'reasoningEffort']) {
    assert.equal(Object.hasOwn(member, key), false);
  }
});

test('unknown fields cannot add budgets, hidden authority or a second persona channel', () => {
  for (const [change, code] of [
    [x => { x.maxStreams = 100; }, 'INVALID_TEMPLATE_FIELDS'],
    [x => { x.members[0].maxStreams = 100; }, 'INVALID_MEMBER_FIELDS'],
    [x => { x.members[0].preset = 'permission-preset'; }, 'INVALID_MEMBER_FIELDS'],
    [x => { x.members[0].system_prompt = 'not a declared field'; }, 'INVALID_MEMBER_FIELDS'],
    [x => { x.template_meta.live_verified = true; }, 'INVALID_TEMPLATE_META'],
    [x => { x.seed_tasks[0].budget = 10; }, 'INVALID_TASK_FIELDS'],
  ]) { const input = clone(example); change(input); rejects(input, code); }
});

test('names, presets, explicit routes and effort are checked before any execution adapter', () => {
  for (const [change, code] of [
    [x => { x.members[1].name = x.members[0].name; }, 'DUPLICATE_MEMBER_NAME'],
    [x => { x.members[1].agent_preset = x.members[0].agent_preset; }, 'DUPLICATE_MEMBER_PRESET'],
    [x => { x.members[0].name = 'lead'; }, 'INVALID_MEMBER_NAME'],
    [x => { delete x.members[0].provider; delete x.members[0].model; }, 'EXPLICIT_MEMBER_ROUTE_REQUIRED'],
    [x => { delete x.members[0].model; }, 'EXPLICIT_MEMBER_ROUTE_REQUIRED'],
    [x => { x.members[0].provider = ' '; }, 'INVALID_MEMBER_ROUTE'],
    [x => { x.members[0].reasoning_effort = ''; }, 'INVALID_MEMBER_EFFORT'],
    [x => { x.max_members = 1; }, 'INVALID_TEMPLATE_MEMBERS'],
    [x => { x.max_members = 9; }, 'INVALID_MAX_MEMBERS'],
  ]) { const input = clone(example); change(input); rejects(input, code); }
});

test('capability validation accepts subsets and empty sets, refuses duplicates and unverified names', () => {
  const empty = clone(example); empty.members[0].native_tool_allowlist = [];
  assert.deepEqual(parseLauncherTemplate(empty).members[0].nativeToolAllowlist, []);
  for (const [allowlist, code] of [
    [['send_message', 'send_message'], 'DUPLICATE_MEMBER_TOOL'],
    [['bash'], 'UNSUPPORTED_MEMBER_TOOL'], [['team_task_list'], 'UNSUPPORTED_MEMBER_TOOL'],
    [['subagent'], 'UNSUPPORTED_MEMBER_TOOL'], [[{ name: 'send_message' }], 'UNSUPPORTED_MEMBER_TOOL'],
  ]) { const input = clone(example); input.members[0].native_tool_allowlist = allowlist; rejects(input, code); }
});

test('task ownership, dependency references, duplicate blockers and cycles fail with stable codes', () => {
  for (const [change, code] of [
    [x => { x.seed_tasks[1].key = x.seed_tasks[0].key; }, 'DUPLICATE_TASK_KEY'],
    [x => { x.seed_tasks[0].owner = 'unrelated-member'; }, 'INVALID_TASK_OWNER'],
    [x => { x.seed_tasks[1].blocked_by = ['missing-task']; }, 'UNKNOWN_TASK_DEPENDENCY'],
    [x => { x.seed_tasks[0].blocked_by = [x.seed_tasks[0].key]; }, 'SELF_TASK_DEPENDENCY'],
    [x => { x.seed_tasks[1].blocked_by.push(x.seed_tasks[0].key); }, 'DUPLICATE_TASK_DEPENDENCY'],
    [x => { x.seed_tasks[0].blocked_by = [x.seed_tasks[1].key]; }, 'TASK_DEPENDENCY_CYCLE'],
  ]) { const input = clone(example); change(input); rejects(input, code); }
});

test('JSON structure and all required fields are checked without evaluating accessors', () => {
  for (const key of ['template_schema', 'version', 'name', 'members']) {
    const input = clone(example); delete input[key]; assert.throws(() => parseLauncherTemplate(input));
  }
  for (const key of ['name', 'description', 'prompt']) {
    const input = clone(example); delete input.members[0][key]; assert.throws(() => parseLauncherTemplate(input));
  }
  const input = clone(example);
  Object.defineProperty(input.members[0], 'persona_prompt', { enumerable: true, get() { assert.fail('persona getter was evaluated'); } });
  rejects(input, 'INVALID_MEMBER_FIELDS');
  const sparse = clone(example); delete sparse.members[0]; rejects(sparse, 'INVALID_TEMPLATE_MEMBERS');
  const proxy = new Proxy(clone(example), { ownKeys() { assert.fail('proxy trap was evaluated'); } });
  rejects(proxy, 'INVALID_TEMPLATE_FIELDS');
  const unicode = clone(example); unicode.members[0].description = '🧩'.repeat(200);
  assert.equal(parseLauncherTemplate(unicode).members[0].description, unicode.members[0].description);
  unicode.members[0].description += '🧩'; rejects(unicode, 'INVALID_MEMBER_DESCRIPTION');
});

test('errors never echo private persona or startup text', () => {
  const input = clone(example), sentinel = 'PRIVATE-PERSONA-AND-STARTUP-DO-NOT-LOG';
  input.members[0].prompt = sentinel; input.members[0].persona_prompt = sentinel;
  input.members[0].native_tool_allowlist = ['bash'];
  assert.throws(() => parseLauncherTemplate(input), error => {
    assert.equal(error.code, 'UNSUPPORTED_MEMBER_TOOL');
    assert.ok(!String(error).includes(sentinel) && !String(error.stack).includes(sentinel)); return true;
  });
});

test('fingerprints are stable for key ordering and tool-set ordering, sensitive to actual template content', () => {
  const original = parseLauncherTemplate(example), fingerprint = launcherTemplateFingerprint(original);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const reordered = Object.fromEntries(Object.entries(clone(example)).reverse());
  reordered.members[0].native_tool_allowlist.reverse();
  assert.equal(launcherTemplateFingerprint(parseLauncherTemplate(reordered)), fingerprint);
  assert.equal(launcherTemplateFingerprint(JSON.parse(JSON.stringify(original))), fingerprint);
  for (const change of [
    x => { x.members[0].prompt += ' new startup'; },
    x => { x.members[0].persona_prompt += ' changed persona'; },
    x => { x.members[1].model = 'another-model'; },
    x => { x.members[0].native_tool_allowlist = ['team_task_get']; },
    x => { x.seed_tasks[0].description += ' different acceptance'; },
  ]) {
    const input = clone(example); change(input);
    assert.notEqual(launcherTemplateFingerprint(parseLauncherTemplate(input)), fingerprint);
  }
  const forged = clone(original); forged.authorized = true;
  assert.throws(() => launcherTemplateFingerprint(forged), error => error.code === 'INVALID_NORMALIZED_TEMPLATE');
});
