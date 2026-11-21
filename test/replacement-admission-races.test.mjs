import test from 'node:test';
import assert from 'node:assert/strict';

import { quietReplacementTree, maintainReplacementTree } from '../src/replacement-native.js';
import { apply } from '../launcher-role.js';
import * as replacement from '../src/member-replacement.js';

const ROOT = 'session-10000000-0000-4000-8000-000000000001';
const OLD = 'session-10000000-0000-4000-8000-000000000002';

test('a cold old member cannot complete an unobserved turn between quiet evidence and the frozen write', async () => {
  const root = { id: ROOT }, agents = new Map([[ROOT, root]]);
  const events = [{ type: 'turn/start', seq: 1 }, { type: 'turn/end', seq: 2 }];
  const ctx = {
    agents: { get: id => agents.get(id) },
    subagents: { async listDescendants() { return [{ kind: 'child', id: OLD, parentId: ROOT,
      depth: 1, mode: 'continuable', activity: 'inactive' }]; } },
    get: key => key === 'jobs' ? { list: () => [] } : undefined,
    sessionQuery: { async observeSession() { return {
      header: { id: OLD }, inheritedEventCount: 0, events: [...events],
      projections: { values: { inbox: { 'next-turn': [], 'next-step': [] } } },
      [Symbol.dispose]() {},
    }; } },
  };
  const signal = new AbortController().signal;
  await assert.rejects(async () => {
    await maintainReplacementTree(ctx, root, OLD, signal, async () => {
      // This completed cold turn represents an external side effect before the
      // durable frozen record. It leaves the Session quiet and tasks untouched.
      events.push({ type: 'turn/start', seq: 3 }, { type: 'tool/result', seq: 4,
        data: { message: { toolCallId: 'call-write', isError: false } } },
      { type: 'turn/end', seq: 5 });
      return 'frozen';
    });
    await quietReplacementTree(ctx, root, OLD, signal);
  }, /REPLACEMENT_(MEMBER_NOT_QUIET|SNAPSHOT_STALE)/);
});

test('an activating candidate loses business eligibility when a transferred terminal task no longer belongs to it', async () => {
  const tools = ['write', 'team_task_update'];
  const catalogTools = [...tools, 'team_task_get', 'send_message'];
  const definitions = catalogTools.map(name => ({ name }));
  const taskMap = new Map();
  let rows = [];
  const root = { id: ROOT, session: { id: ROOT, header: {} }, ctx: {} };
  const agents = new Map([[ROOT, root]]), hooks = [];
  root.ctx.settings = { describe: () => rows };
  const ctx = {
    get: key => key === 'settings' ? root.ctx.settings : key === 'agentTeams' ? {
      getTask(_root, id) { return taskMap.get(id); },
    } : undefined,
    agents: { get: id => agents.get(id) },
    tools: { definitions: () => definitions },
    systemPrompt: { section: () => () => {} },
    on: (event, callback) => { hooks.push({ event, callback }); return () => {}; },
  };
  const started = replacement.startReplacement(replacement.readReplacementRecord(undefined), {
    role: 'implementer', oldChildId: OLD, handoffDigest: 'b'.repeat(64),
    taskRefs: [{ taskId: 'task-1', revision: 1 }], instanceName: 'implementer-r1',
    candidateConfig: JSON.stringify({ role: 'implementer', provider: 'fixture', model: 'local',
      personaPrompt: 'Continue.', prompt: 'Continue.', tools }),
  }, 1);
  const childId = replacement.replacementCandidateOf(started.record.operations[0]).childId;
  let record = replacement.transitionReplacement(started.record, started.operationId, 'standby', 2, { newChildId: childId });
  let op = record.operations[0];
  const ack = replacement.verifyReadinessAck({ text: JSON.stringify({ ready: true, operation: op.id,
    handoff: op.handoffDigest, config: op.configDigest }), senderSessionId: childId, operation: op, at: 3 });
  record = replacement.transitionReplacement(record, op.id, 'ready', 3, { readinessAck: ack.evidence });
  record = replacement.transitionReplacement(record, op.id, 'transferring', 4);
  record = replacement.recordOwnerWriteAttempt(record, op.id, 'task-1', 1, 5);
  record = replacement.recordTaskOutcome(record, op.id, { taskId: 'task-1', kind: 'transferred', revision: 2 }, 6);
  record = replacement.transitionReplacement(record, op.id, 'activating', 7);
  op = record.operations[0];
  rows = [{ ns: 'dsh-native-current-team', revision: 1,
    value: { replacementRecords: { [ROOT]: record } } }];
  taskMap.set('task-1', { id: 'task-1', ownerId: OLD, revision: 3, status: 'completed' });
  await apply(ctx, { ownedSessionId: ROOT, roleName: 'implementer', personaPrompt: 'Continue.', tools,
    standbyOperationId: op.id, replacementOwner: 'dsh-native-current-team' });
  const guards = [], childHooks = [];
  const child = { id: childId, session: { id: childId, header: { origin: 'subagent', parentSession: ROOT } }, ctx: {
    on(event, callback) { childHooks.push({ event, callback }); return () => {}; },
    tools: { guard(callback) { guards.push(callback); return () => {}; }, restrict() { return () => {}; } },
  } };
  agents.set(childId, child);
  for (const hook of hooks) if (hook.event === 'agent/created') hook.callback({ agent: child });
  const exec = { agent: child, name: 'write', arguments: {}, callId: 'call-write', toolSet: {} };
  const denial = guards.map(guard => guard(exec)).find(Boolean);
  assert.equal(denial?.reason, 'TEAM_TASK_OWNERSHIP_CHANGED');
  const chain = childHooks.filter(entry => entry.event === 'agent/pre-step');
  const run = index => index >= chain.length ? { kind: 'enter' }
    : chain[index].callback({ agent: child }, () => run(index + 1));
  assert.deepEqual(await run(0), { kind: 'reject' });
});
