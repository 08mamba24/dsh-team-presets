import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplacementRuntime, nativeReadiness, nativeTaskWrites, quietReplacementTree, maintainReplacementTree } from '../src/replacement-native.js';
import { bindHostContext, createHostAdapter } from '../src/host-adapter.js';

const ROOT = 'session-10000000-0000-4000-8000-000000000001';
const OLD = 'session-10000000-0000-4000-8000-000000000002';
const NEW = 'session-10000000-0000-4000-8000-000000000003';
const OP = { id: 'replace-10000000-0000-4000-8000-000000000004', newChildId: NEW,
  role: 'implementer', instanceName: 'implementer-r1',
  handoffDigest: 'a'.repeat(64), candidateConfig: JSON.stringify({ instanceName: 'implementer-r1' }) };
const ack = () => JSON.stringify({ ready: true, operation: OP.id, handoff: OP.handoffDigest });

test('replacement metadata resolution cannot retain a route revoked while awaiting the adapter', async () => {
  let routes = [{ provider: 'p', model: 'm' }];
  const root = { id: ROOT, session: { id: ROOT, header: {} } };
  const ctx = { on: () => () => {}, agents: { get: () => root }, settings: {},
    tools: { definitions: () => [] }, get: () => ({ allowedRoutes: () => routes }),
    llm: { async resolveCallConfig(route) { routes = []; return { ...route }; } },
    subagents: { startActivation() {}, getProvider: () => ({ capabilities: { agentOptions: true, agentPreset: true, depthLimit: true } }) } };
  bindHostContext(ctx, createHostAdapter({ version: '0.2.3-alpha.2', Context: { root: Symbol('root') } }));
  const runtime = createReplacementRuntime(ctx, { ownedSessionId: ROOT }, {});
  const host = runtime.host(root, new AbortController().signal);
  await assert.rejects(host.preflight({ provider: 'p', model: 'm', reasoningEffort: 'max', tools: [] }),
    { code: 'REPLACEMENT_ROUTE_UNAUTHORIZED' });
});

test('readiness authenticates the real relay source and parses the payload after its native address prefix', () => {
  const message = { id: 'message-ack', source: { kind: 'agent-message', form: 'relay', senderSessionId: NEW },
    content: [{ type: 'text', text: 'Agent implementer-r1 sent a message: ' }, { type: 'text', text: ack() }] };
  assert.deepEqual(nativeReadiness([message], OP), { text: ack(), senderSessionId: NEW, messageId: 'message-ack' });
  for (const source of [{ kind: 'human' }, { ...message.source, kind: 'subagent-settled' },
    { ...message.source, senderSessionId: OLD }]) assert.equal(nativeReadiness([{ ...message, source }], OP), undefined);
  assert.equal(nativeReadiness([{ ...message, content: [{ type: 'text', text: ack() + '\nextra text' }] }], OP), undefined);
});

test('takeover needs an authenticated successful native call/result pair with the named owner and next revision', () => {
  const call = { seq: 3, type: 'tool/call', data: { callId: 'call-1', name: 'team_task_update',
    arguments: JSON.stringify({ task_id: 'task-1', expected_revision: 7, action: 'edit' }) } };
  const result = (task, isError) => ({ seq: 4, type: 'tool/result', data: { message: {
    toolCallId: 'call-1', isError, content: [{ type: 'text', text: JSON.stringify(task) }],
  } } });
  const task = { id: 'task-1', revision: 8, owner: 'implementer-r1' };
  const writes = nativeTaskWrites([call, result(task)], NEW, OP);
  assert.equal(writes.length, 1); assert.equal(writes[0].childId, NEW);
  assert.equal(writes[0].handoffDigest, OP.handoffDigest); assert.equal(writes[0].resultSeq, 4);
  for (const pair of [[result(task)], [call, result(task, true)], [call, result({ ...task, revision: 7 })],
    [call, result({ ...task, owner: 'lead' })]]) assert.deepEqual(nativeTaskWrites(pair, NEW, OP), []);
});

test('logical TaskView owner still proves the exact candidate write and never another role or child', () => {
  const call = { seq: 3, type: 'tool/call', data: { callId: 'logical-write', name: 'team_task_update',
    arguments: JSON.stringify({ task_id: 'task-1', expected_revision: 7, action: 'edit' }) } };
  const result = owner => ({ seq: 4, type: 'tool/result', data: { message: {
    toolCallId: 'logical-write', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ id: 'task-1', revision: 8, owner }) }],
  } } });
  assert.equal(nativeTaskWrites([call, result('implementer')], NEW, OP).length, 1);
  for (const owner of ['reviewer', 'lead', 'implementer-r2', undefined]) {
    assert.deepEqual(nativeTaskWrites([call, result(owner)], NEW, OP), []);
  }
  assert.deepEqual(nativeTaskWrites([call, result('implementer')], OLD, OP), []);
});

function fixture({ cold = false, activeJob = false, status = 'idle', queued = false, openTurn = false } = {}) {
  const order = [], root = { id: ROOT }, agents = new Map([[ROOT, root]]);
  const old = { id: OLD, session: { id: OLD, header: { parentSession: ROOT }, snapshotEvents: () => [] }, status,
    inbox: { nextStep: [], nextTurn: queued ? [{ id: 'waiting-input' }] : [] },
    async runMaintenance(body) { order.push('old-maintenance'); return body(new AbortController().signal); } };
  if (!cold) agents.set(OLD, old);
  const ctx = { agents: { get: id => agents.get(id) },
    subagents: { async listDescendants() { return [{ kind: 'child', id: OLD, parentId: ROOT, depth: 1,
      mode: 'continuable', activity: cold ? 'inactive' : 'running' }]; } },
    get() { return { list: () => activeJob ? [{ owner: OLD, status: 'running' }] : [] }; },
    sessionQuery: { async observeSession() { return { header: { id: OLD }, inheritedEventCount: 0,
      projections: { values: { inbox: { 'next-turn': [], 'next-step': [] } } },
      events: [{ type: 'turn/start', seq: 1 }, ...openTurn ? [] : [{ type: 'turn/end', seq: 2 }]],
      [Symbol.dispose]() { order.push('observation-disposed'); } }; } },
  };
  return { ctx, root, old, agents, order };
}

test('quiescence checks resident work, queued input, managed background jobs and cold Session settlement', async () => {
  for (const options of [{ status: 'running' }, { queued: true }, { activeJob: true }, { cold: true, openTurn: true }]) {
    const h = fixture(options);
    await assert.rejects(quietReplacementTree(h.ctx, h.root, OLD, new AbortController().signal));
  }
  const h = fixture({ cold: true });
  assert.deepEqual((await quietReplacementTree(h.ctx, h.root, OLD, new AbortController().signal)).ids, [OLD]);
  assert.deepEqual(h.order, ['observation-disposed']);
});

test('freeze claims the old Agent maintenance phase without requiring the tool-calling root to be idle', async () => {
  const h = fixture(); h.root.status = 'running';
  const value = await maintainReplacementTree(h.ctx, h.root, OLD, new AbortController().signal,
    async () => { h.order.push('freeze'); return 'persisted'; });
  assert.equal(value, 'persisted'); assert.deepEqual(h.order, ['old-maintenance', 'freeze']);
});

test('unrelated unowned job progress does not invalidate the target member quiet snapshot', async () => {
  const h = fixture({ cold: true }); let progress = 0;
  h.ctx.get = () => ({ list: () => [{ id: 'unowned-other-work', status: 'running', output: { total: ++progress } }] });
  assert.equal(await maintainReplacementTree(h.ctx, h.root, OLD, new AbortController().signal, async () => 'frozen'), 'frozen');
});
