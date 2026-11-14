import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLive } from '../src/driver.js';
import { apply as applyRole } from '../role.js';

// Synthetic Host contract fixture. These tests are not Desktop/native subagent acceptance.
async function fixture(t, options = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-live-one-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = { ownedSessionId: 'session-20000000-0000-4000-8000-000000000001', workspace,
    runTag: 'live-one-648', memberName: 'live-648-implementer', presetId: 'dsh-live-648-implementer',
    personaNonce: 'persona-live-648-abc123', timeoutMs: options.hang ? 15 : 1000,
    route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 1024 } };
  await writeFile(join(workspace, '.dsh-subagent-live.json'), JSON.stringify({ purpose: 'dsh-subagent-live-one', ownedSessionId: config.ownedSessionId, runTag: config.runTag }), { mode: 0o600 });
  const commands = new Map(), hooks = new Map(), agents = new Map(), effects = [], calls = [];
  let starts = 0, metadata = 0, mounts = 0, providerCalls = 0, disposed = 0, unregisters = 0, interruptions = 0, nativeMounted = false, finish;
  const emit = (name, value) => { for (const f of hooks.get(name) ?? []) f(value); };
  const root = { id: config.ownedSessionId, session: { id: config.ownedSessionId, header: { cwd: workspace } },
    status: 'idle', model: { current: () => config.route }, ctx: {},
    inbox: { nextStep: [], nextTurn: [], remove(id) {
      const i = this.nextTurn.findIndex(x => x.id === id); if (i < 0) return false;
      this.nextTurn.splice(i, 1);return true;
    } },
    async runMaintenance(task) { assert.equal(this.status, 'idle');return task(new AbortController().signal); },
    async whenIdle() {},
  };
  agents.set(root.id, root);
  const native = { apply() {} };
  const rootTools = {
    async resolve() {
      if (options.toolResolution) { options.toolResolution.entered(); await options.toolResolution.ready; }
      return { view: agent => new Map(nativeMounted && agent === root ? [['dsh_live_one_spawn', {}]] : []), dispose() {} };
    },
    async execute(input) {
      starts++;assert.equal(input.agent, root);assert.equal(input.calls[0].name, 'dsh_live_one_spawn');
      const args = JSON.parse(input.calls[0].arguments);calls.push(args);
      assert.equal(args.agent_preset, config.presetId);assert.equal(args.reasoning_effort, 'low');
      assert.ok(!args.prompt.includes(config.personaNonce), 'nonce must come from the actual role composition');
      const child = { id: 'child-648', session: { header: { origin: 'subagent', parentSession: root.id } },
        model: { current: () => config.route }, options: { maxTokens: 1024 }, ctx: {} };
      agents.set(child.id, child);
      const toolNames = new Map([['bash', { execute: () => assert.fail('forbidden shell was reached') }]]);
      const roleHandlers = [];
      child.ctx.tools = {
        restrict(f) { assert.deepEqual(f, { allow: [] });toolNames.clear(); },
        register(def) { toolNames.set(def.name, def); },
        async resolve() { return { view: () => toolNames, dispose() {} }; },
        async execute(batch) {
          const c = batch.calls[0], def = toolNames.get(c.name);
          const result = def ? { isError: false, value: await def.execute(JSON.parse(c.arguments)) } : { isError: true };
          return { results: [{ callId: c.id, result }], additionalContexts: [], concluded: false };
        },
      };
      child.ctx.effect = () => {};
      const roleCtx = { systemPrompt: { section(s) { assert.ok(s.text.includes(config.personaNonce)); } },
        on(name, fn) { assert.equal(name, 'agent/created');roleHandlers.push(fn); }, emit };
      await applyRole(roleCtx, { ownedSessionId: root.id, runTag: config.runTag, personaNonce: config.personaNonce });
      for (const fn of roleHandlers) await fn({ agent: child });
      emit('subagent/start', { id: child.id, runId: 'run-648', parentSessionId: root.id, provider: 'spawn', local: true });
      finish = async () => {
        let stopReason = 'completed';
        try {
          const hook = [...hooks.get('llm/stream')][0];
          const stream = async function* () { providerCalls++;yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 11 } };yield { type: 'finish', reason: 'stop' }; };
          for await (const _ of (hook ? hook({ ...config.route, sessionId: child.id }, stream) : stream())) {}
        } catch { stopReason = 'error'; }
        root.inbox.nextTurn.push({ id: 'notice-648', source: { kind: 'subagent-settled', senderSessionId: child.id } });
        if (options.foreignInbox) root.inbox.nextTurn.push({ id: 'user-message', source: { kind: 'user' } });
        emit('subagent/end', { id: child.id, runId: 'run-648', parentSessionId: root.id, stopReason,
          lastAssistantMessage: [{ type: 'text', text: JSON.stringify({ role: 'implementer', personaNonce: config.personaNonce, value: 5 }) }] });
      };
      if (!options.hang) queueMicrotask(finish);
      return { results: [{ callId: input.calls[0].id, result: { isError: false, value: { kind: 'activation', name: config.memberName } } }], additionalContexts: [], concluded: false };
    },
  };
  root.ctx.tools = rootTools;
  root.ctx.plugin = (module, spec) => {
    assert.equal(module, native);assert.equal(spec.maxDepth, 1);assert.equal(spec.agentOptions.maxTokens, 1024);
    assert.deepEqual(spec.allowedAgentPresets, [config.presetId]);mounts++;nativeMounted = true;
    const p = Promise.resolve();p.dispose = async () => { disposed++;nativeMounted = false; };return p;
  };
  const ctx = { agents: { get: id => agents.get(id) },
    sessionProjections: { stateOf(session, key) { assert.equal(session, root.session);assert.equal(key, 'subagentModelSelectionPolicy');return options.unauthorized ? [] : [config.route]; } },
    llm: { async resolveCallConfig(x) { metadata++;return options.drift ? { ...x, maxTokens: 2048 } : x; } },
    subagents: { interrupt(id, auth) {
      assert.equal(id, 'child-648');assert.equal(auth.agent, root);interruptions++;
      if (options.throwInterrupt) throw new Error('synthetic interrupt failed');
    } },
    agentPresets: { async register(def) { assert.equal(def.id, config.presetId);return async () => { unregisters++; }; }, composedPreset: () => config.presetId },
    on(name, fn) { if (!hooks.has(name)) hooks.set(name, new Set());hooks.get(name).add(fn);return () => hooks.get(name).delete(fn); },
    commands: { register(def) { commands.set(def.name, def);return () => commands.delete(def.name); } },
    effect(generator) { for (const dispose of generator()) effects.push(dispose); },
  };
  await applyLive(ctx, config, native);
  return { ctx, root, config, hooks, calls, invoke: (signal = new AbortController().signal) => commands.get('dsh-subagent-live').handler({ agent: root, rawInput: 'run-one', attachments: [], signal }),
    dispose: async () => { for (const f of effects.slice().reverse()) await f(); }, release: () => finish(),
    stats: () => ({ starts, metadata, mounts, providerCalls, disposed, unregisters, interruptions, nativeMounted }) };
}

test('one native-tool submission uses a real role module, captures output/usage and cancels only its settlement notice', async t => {
  const h = await fixture(t);const r = await h.invoke();assert.equal(r.kind, 'success', r.text);
  const v = JSON.parse(r.text);assert.equal(v.childSessionId, 'child-648');assert.equal(v.modelEvidence.admissions, 1);
  assert.equal(v.roleAudit.forbiddenTool, 'bash');assert.deepEqual(v.cancelledParentNoticeIds, ['notice-648']);
  assert.equal(h.root.inbox.nextTurn.length, 0);assert.equal(h.stats().disposed, 1);
  assert.match((await h.invoke()).text, /RUN_ALREADY_ATTEMPTED/);assert.equal(h.stats().starts, 1);
  await h.dispose();assert.equal(h.stats().unregisters, 1);
});

test('policy and preflight refusal never invoke the native delegation executor', async t => {
  for (const options of [{ unauthorized: true }, { drift: true }]) {
    const h = await fixture(t, options);const r = await h.invoke();assert.equal(r.kind, 'error');
    assert.equal(h.stats().starts, 0);assert.equal(h.stats().disposed, 1);
    if (options.unauthorized) assert.equal(h.stats().metadata, 0);
    await h.dispose();
  }
});

test('a busy owned root is left alone before mounting or model metadata lookup', async t => {
  const h = await fixture(t);h.root.status = 'running';
  const r = await h.invoke();assert.match(r.text, /ROOT_NOT_IDLE/);
  assert.equal(h.stats().starts, 0);assert.equal(h.stats().metadata, 0);assert.equal(h.stats().nativeMounted, false);
  await h.dispose();
});

test('a wrong-root marker cannot admit an operation', async t => {
  const h = await fixture(t);
  await writeFile(join(h.config.workspace, '.dsh-subagent-live.json'), JSON.stringify({ purpose: 'dsh-subagent-live-one', ownedSessionId: 'wrong-root', runTag: h.config.runTag }));
  const r = await h.invoke();assert.match(r.text, /INVALID_MARKER/);
  assert.equal(h.stats().starts, 0);assert.equal(h.stats().metadata, 0);
  await h.dispose();
});

test('unrelated input is retained and fails the run instead of being cleared as a child notice', async t => {
  const h = await fixture(t, { foreignInbox: true });const r = await h.invoke();
  assert.equal(r.kind, 'error');assert.match(r.text, /ROOT_INBOX_CHANGED/);
  assert.ok(h.root.inbox.nextTurn.some(m => m.id === 'user-message'));assert.equal(h.stats().disposed, 1);
  await h.dispose();
});

test('deadline reports draining; unload retains the guard until the exact child settles', async t => {
  const h = await fixture(t, { hang: true });const r = await h.invoke();
  assert.match(r.text, /TIMEOUT_DRAINING_GUARD_RETAINED/);
  let unloaded = false;const disposal = h.dispose().then(() => { unloaded = true; });
  await new Promise(resolve => setImmediate(resolve));assert.equal(unloaded, false);
  assert.equal(h.hooks.get('llm/stream').size, 1);assert.ok(h.stats().interruptions >= 1);
  await h.release();await disposal;assert.equal(h.hooks.get('llm/stream').size, 0);assert.equal(h.stats().disposed, 1);
});

test('unload during asynchronous ownership validation refuses the admitted command before any runtime work', async t => {
  const h = await fixture(t);
  const command = h.invoke(); // assertOwned is waiting for real filesystem I/O.
  await h.dispose();
  assert.equal(h.hooks.get('llm/stream').size, 0);
  const result = await command;
  assert.equal(JSON.parse(result.text).code, 'UNLOADING');
  assert.deepEqual({ metadata: h.stats().metadata, mounts: h.stats().mounts,
    executor: h.stats().starts, provider: h.stats().providerCalls },
  { metadata: 0, mounts: 0, executor: 0, provider: 0 });
});

test('cancellation during tool resolution stops dispatch while unload waits for the claimed operation', async t => {
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { toolResolution: { entered, ready } });
  const command = h.invoke();await reached;
  let unloaded = false;
  const disposal = h.dispose().then(() => { unloaded = true; });
  await new Promise(resolve => setImmediate(resolve));
  const beforeRelease = { unloaded, hooks: h.hooks.get('llm/stream').size };
  release();await command;await disposal;
  assert.deepEqual(beforeRelease, { unloaded: false, hooks: 1 });
  assert.equal(h.stats().starts, 0);assert.equal(h.stats().providerCalls, 0);
  assert.equal(h.hooks.get('llm/stream').size, 0);
});

test('an interrupt exception cannot finish unload before the exact late child end', async t => {
  const h = await fixture(t, { hang: true, throwInterrupt: true });
  const result = await h.invoke();assert.match(result.text, /TIMEOUT_DRAINING_GUARD_RETAINED/);
  let settled = false, disposalError;
  const disposal = h.dispose().then(() => { settled = true; }, error => { settled = true;disposalError = error; });
  await new Promise(resolve => setImmediate(resolve));
  const beforeEnd = { settled, hooks: h.hooks.get('llm/stream').size };
  await assert.rejects(async () => {
    const hook = [...h.hooks.get('llm/stream')][0];
    for await (const _ of hook({ sessionId: h.root.id }, () => assert.fail('root guard was bypassed'))) {}
  }, /ROOT_QUARANTINED/);
  await h.release();await disposal;
  if (disposalError) await h.dispose(); // Release the synthetic fixture even on the unfixed implementation.
  assert.deepEqual(beforeEnd, { settled: false, hooks: 1 });
  assert.equal(disposalError, undefined);
  assert.equal(JSON.parse(result.text).interruptFailed, true);
  assert.equal(h.hooks.get('llm/stream').size, 0);assert.equal(h.stats().unregisters, 1);
});
