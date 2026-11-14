import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLauncherMembers } from '../src/launcher-plan.js';

// These observations are synthetic supplied facts, not a claim of real persona observability.
const template = () => ({
  templateSchema: 'dsh-team-template/1', templateMeta: { liveVerified: false }, version: 1,
  name: 'test-team', maxMembers: 4, seedTasks: [],
  members: ['implementer', 'reviewer'].map((role, index) => ({
    name: role, description: `Owned ${role} task`, prompt: `Initial ${role} input`,
    agentPreset: `dsh-team-test-${role}`, provider: 'deepseek-account',
    model: index === 0 ? 'deepseek-flash' : 'deepseek-v4-pro', reasoningEffort: 'low',
    personaPrompt: `Persistent ${role} persona`, nativeToolAllowlist: ['team_task_get', 'team_task_update'],
  })),
});
const observation = spec => ({ complete: true, members: spec.members.map((member, index) => ({
  id: `child-${index}`, name: member.name, description: member.description,
  agentPreset: member.agentPreset, provider: member.provider, model: member.model,
  reasoningEffort: member.reasoningEffort, personaPrompt: member.personaPrompt,
  nativeToolAllowlist: [...member.nativeToolAllowlist],
})) });

function deeplyFrozen(value) {
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) if (child && typeof child === 'object') deeplyFrozen(child);
}

test('a complete valid native catalog proves absence before planning CREATE', () => {
  const spec = template();
  const plan = planLauncherMembers(spec, { complete: true, members: [] });
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.members.map(member => [member.name, member.action]), [['implementer', 'create'], ['reviewer', 'create']]);
  assert.ok(plan.members.every(member => !Object.hasOwn(member, 'childId')));
  assert.deepEqual(plan.foreignMembers, []);
  deeplyFrozen(plan);
});

test('fully matching explicitly observed roles can be reused in the pure synthetic plan', () => {
  const spec = template(), observed = observation(spec);
  const before = structuredClone({ spec, observed });
  const plan = planLauncherMembers(spec, observed);
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.members.map(member => member.action), ['reuse', 'reuse']);
  assert.deepEqual(plan.members.map(member => member.childId), ['child-0', 'child-1']);
  assert.ok(plan.members.every(member => member.driftFields.length === 0 && member.unverifiableFields.length === 0));
  assert.deepEqual({ spec, observed }, before);
  assert.equal(Object.isFrozen(observed), false, 'the planner must not freeze its input');
  deeplyFrozen(plan);
});

test('startup prompt is create-only input, never current persona evidence or a resend instruction', () => {
  const spec = template(), observed = observation(spec);
  spec.members[0].prompt = 'A different one-time task that must not be sent again';
  const plan = planLauncherMembers(spec, observed);
  assert.equal(plan.members[0].action, 'reuse');
  assert.equal(Object.hasOwn(plan.members[0], 'prompt'), false);
  assert.equal(Object.hasOwn(plan.members[0], 'startupPrompt'), false);
  observed.members[0].personaPrompt = spec.members[0].prompt;
  assert.deepEqual(planLauncherMembers(spec, observed).members[0].driftFields, ['personaPrompt']);
});

test('description requires an actual native catalog label and cannot be inferred from the spec', () => {
  const spec = template(), observed = observation(spec);
  delete observed.members[0].description;
  const missing = planLauncherMembers(spec, observed);
  assert.equal(missing.members[0].action, 'conflict');
  assert.deepEqual(missing.members[0].unverifiableFields, ['description']);
  observed.members[0].description = 'Another native label';
  assert.deepEqual(planLauncherMembers(spec, observed).members[0].driftFields, ['description']);
});

test('every explicit scalar must be currently observable and equal', () => {
  for (const key of ['agentPreset', 'provider', 'model', 'reasoningEffort', 'personaPrompt']) {
    const spec = template(), observed = observation(spec);
    observed.members[0][key] = 'different';
    const drift = planLauncherMembers(spec, observed);
    assert.equal(drift.blocked, true);
    assert.deepEqual(drift.members[0].driftFields, [key]);
    delete observed.members[0][key];
    assert.deepEqual(planLauncherMembers(spec, observed).members[0].unverifiableFields, [key]);
  }
});

test('preset IDs and historical receipts do not prove an unobservable current persona or tool set', () => {
  const spec = template(), observed = observation(spec);
  delete observed.members[0].personaPrompt;
  delete observed.members[0].nativeToolAllowlist;
  observed.members[0].receipt = { personaPrompt: spec.members[0].personaPrompt, nativeToolAllowlist: spec.members[0].nativeToolAllowlist };
  observed.members[0].personaObservable = false;
  const result = planLauncherMembers(spec, observed);
  assert.equal(result.members[0].action, 'conflict');
  assert.deepEqual(result.members[0].unverifiableFields, ['personaPrompt', 'nativeToolAllowlist']);
});

test('missing intended persona or capability configuration cannot establish reuse by inference', () => {
  const spec = template(), observed = observation(spec);
  delete spec.members[0].personaPrompt;
  delete spec.members[0].nativeToolAllowlist;
  const result = planLauncherMembers(spec, observed);
  assert.equal(result.members[0].action, 'conflict');
  assert.deepEqual(result.members[0].unverifiableFields, ['personaPrompt', 'nativeToolAllowlist']);
});

test('unspecified preset and effort do not silently become explicit expected defaults', () => {
  const spec = template(), observed = observation(spec);
  delete spec.members[0].agentPreset;
  delete spec.members[0].reasoningEffort;
  delete observed.members[0].agentPreset;
  observed.members[0].reasoningEffort = 'max';
  assert.equal(planLauncherMembers(spec, observed).members[0].action, 'reuse');
});

test('tool allowlists are compared as sets, including an explicitly observed empty set', () => {
  const spec = template(), observed = observation(spec);
  observed.members[0].nativeToolAllowlist.reverse();
  observed.members[0].nativeToolAllowlist.push('team_task_get');
  assert.equal(planLauncherMembers(spec, observed).members[0].action, 'reuse');
  observed.members[0].nativeToolAllowlist = ['team_task_get'];
  assert.deepEqual(planLauncherMembers(spec, observed).members[0].driftFields, ['nativeToolAllowlist']);
  spec.members[0].nativeToolAllowlist = [];
  observed.members[0].nativeToolAllowlist = [];
  assert.equal(planLauncherMembers(spec, observed).members[0].action, 'reuse');
  observed.members[0].nativeToolAllowlist = ['team_task_get', null];
  assert.deepEqual(planLauncherMembers(spec, observed).members[0].unverifiableFields, ['nativeToolAllowlist']);
});

test('an absent, false, malformed, or live-registry-only completeness claim cannot plan creation or reuse', () => {
  const spec = template();
  for (const observed of [undefined, {}, { complete: false, members: [] }, { complete: 'true', members: [] },
    { complete: true }, { complete: true, members: {} }, { ...observation(spec), complete: false }]) {
    const result = planLauncherMembers(spec, observed);
    assert.equal(result.blocked, true);
    assert.ok(result.members.every(member => member.action === 'conflict'));
    assert.ok(result.reasons.length > 0);
  }
});

test('duplicate names, duplicate IDs, and invalid native member identities invalidate the catalog', () => {
  const mutations = [
    o => o.members.push({ ...o.members[0], id: 'another-child' }),
    o => { o.members[1].id = o.members[0].id; },
    o => { o.members[0].id = ''; },
    o => { o.members[0].id = null; },
    o => { o.members[0].id = 'invalid child id'; },
    o => { o.members[0].name = 'lead'; },
    o => { o.members[0].name = '../foreign'; },
    o => o.members.push(null),
  ];
  for (const mutate of mutations) {
    const spec = template(), observed = observation(spec); mutate(observed);
    const result = planLauncherMembers(spec, observed);
    assert.equal(result.blocked, true);
    assert.ok(result.members.every(member => member.action === 'conflict'));
    assert.ok(result.reasons.some(reason => /DUPLICATE_MEMBER|INVALID_MEMBER_IDENTITY/.test(reason)));
  }
});

test('foreign members stay untouched and are detached identities, not a sidecar roster', () => {
  const spec = template(), observed = observation(spec);
  const foreign = { id: 'foreign-child', name: 'other-member', personaPrompt: 'Unrelated persona', nativeToolAllowlist: ['bash'] };
  observed.members.push(foreign);
  const result = planLauncherMembers(spec, observed);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.foreignMembers, [{ id: 'foreign-child', name: 'other-member' }]);
  assert.deepEqual(foreign, observed.members[2]);
  assert.notEqual(result.foreignMembers[0], foreign);
  assert.equal(Object.hasOwn(result.foreignMembers[0], 'action'), false);
  deeplyFrozen(result);
});

test('a malformed or duplicate-name normalized template fails closed without throwing', () => {
  for (const spec of [undefined, {}, { ...template(), templateSchema: 'other' },
    { ...template(), members: [] }, { ...template(), members: [template().members[0], template().members[0]] }]) {
    const result = planLauncherMembers(spec, { complete: true, members: [] });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.members, []);
    deeplyFrozen(result);
  }
});
