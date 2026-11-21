import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTeamReplacement } from '../src/team-replace.js';
import { nativeEffectOwner } from './fixtures/native-effect-owner.mjs';

const ROOT = { id: 'session-10000000-0000-4000-8000-000000000001' };
const OLD = 'session-10000000-0000-4000-8000-000000000002';
const input = () => ({ action: 'replace', role: 'implementer', expectedOldChildId: OLD,
  provider: 'fixture', model: 'local', personaPrompt: 'Implement carefully.', prompt: 'Continue the existing task.',
  tools: ['write'], progressFacts: 'src/a.js changed; no background work; continue task-1.' });

async function fixture(t) {
  const owner = nativeEffectOwner(), tools = new Map(), skills = new Map(), requests = [];
  const ctx = { effect: owner.effect, tools: { register(tool) { tools.set(tool.name, tool); } },
    skills: { register(skill) { skills.set(skill.name, skill); } } };
  const launcher = { assertRoot(agent) { if (agent !== ROOT) throw Object.assign(new Error('WRONG_AGENT'), { code: 'WRONG_AGENT' }); },
    async replacement(request) { requests.push(request); return { ok: true, operationId: 'fixture-operation' }; } };
  await applyTeamReplacement(ctx, launcher, { defineTool: value => value });
  t.after(() => owner.dispose());
  return { requests, skills, owner, async invoke(args, agent = ROOT, signal = new AbortController().signal) {
    return JSON.parse(await tools.get('dsh_team_replace').execute(args, { agent, signal }));
  } };
}

test('Agent-facing replacement binds the observed old member and preserves explicit configuration', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke(input())).ok, true);
  const forwarded = f.requests[0];
  assert.equal(forwarded.agent, ROOT); assert.equal(forwarded.expectedOldChildId, OLD);
  assert.equal(forwarded.request.prompt, input().prompt);
  assert.equal(forwarded.request.reasoningEffort, 'max');
  assert.deepEqual(forwarded.request.tools, ['write']);
  assert.ok(f.skills.get('dsh-team-replace').content.includes('action: recover'));
});

test('child, stale cancellation and unloading cannot initiate replacement', async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort();
  assert.equal((await f.invoke(input(), { id: 'child' })).code, 'WRONG_AGENT');
  assert.equal((await f.invoke(input(), ROOT, aborted.signal)).ok, false);
  await f.owner.dispose();
  assert.equal((await f.invoke(input())).code, 'UNLOADING');
  assert.equal(f.requests.length, 0);
});

test('missing old identity, unsupported role and ambiguous recovery input are refused before mutation', async t => {
  const f = await fixture(t);
  for (const args of [{ ...input(), expectedOldChildId: undefined }, { ...input(), role: 'third-role' },
    { ...input(), extra: true }, { action: 'inspect', role: 'implementer' },
    { action: 'recover', operationId: 'replace-not-a-uuid' }, { action: 'recover', operationId: 'replace-' + 'a'.repeat(36), prompt: 'retry' }]) {
    assert.equal((await f.invoke(args)).ok, false);
  }
  assert.equal(f.requests.length, 0);
});
