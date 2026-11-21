import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../launcher-role.js';

const TOOLS = ['team_task_get', 'team_task_update', 'send_message', 'wait_agent'];
const example = () => ({ ownedSessionId: 'session-20000000-0000-4000-8000-000000000002',
  roleName: 'implementer', personaPrompt: '按任务要求实现，并给出可核对的结果。\n保留这段原文与 {{literal_placeholder}}。',
  tools: ['team_task_get', 'team_task_update', 'send_message'] });
const hasCode = code => error => error.code === code && error.message === code && error.name === 'LauncherRoleError';

// Only the public context ownership contract is synthetic; no Host, Session or provider is started.
function fixture() {
  const sections = new Map(), hooks = new Set(), presetDisposers = [];
  const ctx = {
    systemPrompt: { section(section) {
      sections.set(section.name, section);
      const dispose = () => sections.delete(section.name); presetDisposers.push(dispose); return dispose;
    } },
    on(event, callback) {
      assert.equal(event, 'agent/created'); hooks.add(callback);
      const dispose = () => hooks.delete(callback); presetDisposers.push(dispose); return dispose;
    },
  };
  const makeAgent = ({ origin = 'subagent', parentSession = example().ownedSessionId, known = TOOLS } = {}) => {
    const restrictions = [], childDisposers = [];
    const agent = { session: { header: { origin, parentSession } }, ctx: { tools: {
      restrict(filter) {
        assert.ok(filter.allow.every(tool => known.includes(tool)), 'native unknown-name restriction');
        const mask = { allow: [...filter.allow] }; restrictions.push(mask);
        const dispose = () => restrictions.splice(restrictions.indexOf(mask), 1); childDisposers.push(dispose); return dispose;
      },
    } } };
    return { agent, restrictions, dispose() { for (const dispose of childDisposers.splice(0).reverse()) dispose(); } };
  };
  return { ctx, sections, hooks, makeAgent,
    created: payload => { for (const callback of hooks) callback(payload); },
    dispose() { for (const dispose of presetDisposers.splice(0).reverse()) dispose(); } };
}

test('launcher persona is the exact supplied section and each role gets its own native mask', async () => {
  for (const config of [example(), { ...example(), roleName: 'reviewer', personaPrompt: '独立核对证据，明确给出审查结论。',
    tools: ['team_task_get', 'team_task_update', 'wait_agent'] }]) {
    const h = fixture(); await apply(h.ctx, config);
    assert.deepEqual(h.sections.get('deployment:persona-prefix'), { name: 'deployment:persona-prefix', order: 0,
      text: config.personaPrompt, interpolate: false });
    const child = h.makeAgent(); h.created({ agent: child.agent });
    assert.deepEqual(child.restrictions, [{ allow: config.tools }]); child.dispose(); h.dispose();
  }
});

test('launcher role freezes accepted persona and tools instead of following later config edits', async () => {
  const config = example(), original = structuredClone(config), h = fixture(); await apply(h.ctx, config);
  config.personaPrompt = 'later replacement'; config.ownedSessionId = 'other-root'; config.tools.push('wait_agent');
  const child = h.makeAgent(); h.created({ agent: child.agent });
  assert.equal(h.sections.get('deployment:persona-prefix').text, original.personaPrompt);
  assert.deepEqual(child.restrictions, [{ allow: original.tools }]); child.dispose(); h.dispose();
});

test('an explicit empty subset installs the native empty allow mask', async () => {
  const h = fixture(); await apply(h.ctx, { ...example(), roleName: 'observer', tools: [] });
  const child = h.makeAgent(); h.created({ agent: child.agent }); assert.deepEqual(child.restrictions, [{ allow: [] }]);
  child.dispose(); h.dispose();
});

test('wrong origin or parent refuses before any tool restriction', async () => {
  const h = fixture(); await apply(h.ctx, example());
  for (const origin of ['user', 'root', undefined]) {
    const child = h.makeAgent(); child.agent.session.header.origin = origin;
    assert.throws(() => h.created({ agent: child.agent }), hasCode('LAUNCHER_ROLE_WRONG_ORIGIN')); assert.deepEqual(child.restrictions, []);
  }
  const other = h.makeAgent({ parentSession: 'other-root' });
  assert.throws(() => h.created({ agent: other.agent }), hasCode('LAUNCHER_ROLE_WRONG_PARENT')); assert.deepEqual(other.restrictions, []);
  assert.throws(() => h.created(undefined), hasCode('LAUNCHER_ROLE_WRONG_ORIGIN')); h.dispose();
});

test('strict config rejects unknown or missing fields without installing context contributions', async () => {
  const accessor = { ...example() }; Object.defineProperty(accessor, 'personaPrompt', { get() { throw new Error('private prompt'); } });
  for (const config of [null, [], {}, { ...example(), nonce: 'unrequested' }, { ...example(), budget: 1 },
    Object.fromEntries(Object.entries(example()).filter(([key]) => key !== 'roleName')), accessor,
    { ...example(), [Symbol('extra')]: true }]) {
    const h = fixture(); await assert.rejects(apply(h.ctx, config), hasCode('LAUNCHER_ROLE_INVALID_CONFIG'));
    assert.equal(h.sections.size, 0); assert.equal(h.hooks.size, 0);
  }
});

test('owner, role and persona have finite validated values', async () => {
  for (const [key, values, code] of [
    ['ownedSessionId', ['', 'x'.repeat(129), 'root with spaces', null], 'LAUNCHER_ROLE_INVALID_OWNER'],
    ['roleName', ['', 'lead', 'Bad Name', 'x'.repeat(33), null], 'LAUNCHER_ROLE_INVALID_NAME'],
    ['personaPrompt', ['', ' \n\t', 'x'.repeat(16385), 'before\0after', {}], 'LAUNCHER_ROLE_INVALID_PERSONA'],
  ]) for (const value of values) await assert.rejects(apply(fixture().ctx, { ...example(), [key]: value }), hasCode(code));
  const h = fixture(); await apply(h.ctx, { ...example(), ownedSessionId: 'x'.repeat(128), roleName: 'x'.repeat(32), personaPrompt: 'x'.repeat(16384) }); h.dispose();
});

test('role tool names are explicit and unique, with orchestration capabilities excluded', async () => {
  for (const tools of [undefined, 'send_message', ['spawn_agent'], ['team_task_get', 'team_task_get'],
    ['team_task_list'], [...TOOLS, 'run_code'], [null], Array(1)]) {
    await assert.rejects(apply(fixture().ctx, { ...example(), tools }), hasCode('LAUNCHER_ROLE_INVALID_TOOLS'));
  }
  const h = fixture(); await apply(h.ctx, { ...example(), tools: ['read', 'bash'] }); h.dispose();
});

test('missing or failed native restriction emits a stable code without leaking persona or native errors', async () => {
  const sensitive = 'SENSITIVE_PERSONA_DO_NOT_ECHO', h = fixture(); await apply(h.ctx, { ...example(), personaPrompt: sensitive });
  const child = h.makeAgent(); child.agent.ctx.tools.restrict = () => { throw new Error(sensitive); };
  assert.throws(() => h.created({ agent: child.agent }), error => hasCode('LAUNCHER_ROLE_TOOLS_UNAVAILABLE')(error) && !String(error).includes(sensitive));
  delete child.agent.ctx.tools.restrict;
  assert.throws(() => h.created({ agent: child.agent }), hasCode('LAUNCHER_ROLE_TOOLS_UNAVAILABLE'));
  await assert.rejects(apply(h.ctx, { ...example(), personaPrompt: sensitive, extra: true }), error =>
    hasCode('LAUNCHER_ROLE_INVALID_CONFIG')(error) && !String(error).includes(sensitive)); h.dispose();
});

test('native context disposal removes persona and hooks, and child disposal removes only its mask', async () => {
  const h = fixture(); await apply(h.ctx, example()); const child = h.makeAgent(); h.created({ agent: child.agent });
  assert.equal(h.sections.size, 1); assert.equal(h.hooks.size, 1); assert.equal(child.restrictions.length, 1);
  child.dispose(); assert.equal(child.restrictions.length, 0); assert.equal(h.sections.size, 1);
  h.dispose(); assert.equal(h.sections.size, 0); assert.equal(h.hooks.size, 0);
  const later = h.makeAgent(); h.created({ agent: later.agent }); assert.deepEqual(later.restrictions, []);
});
