// The historical file-bound entry relies on POSIX ownership and mode bits.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' ? 'Legacy macOS file-bound entry' : false }, fn);
import { launcherHost } from './fixtures/launcher-host.mjs';
import { nativeEffectOwner } from './fixtures/native-effect-owner.mjs';

// RED evidence may select one byte-identical historical driver module whose
// unchanged helpers are symlinks. Normal tests always import the actual driver.
const { applyLauncher } = await import(process.env.DSH_LAUNCHER_DRIVER_TARGET ?? new URL('../src/launcher-driver.js', import.meta.url));

const decode = envelope => ({ ...envelope, value: JSON.parse(envelope.text) });
const modeWrites = host => host.writes.filter(write => write.kind === 'mode').map(write => write.value);
const hookCount = host => host.hooks.get('llm/stream')?.size ?? 0;
const eventually = async predicate => {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'bounded native fixture did not reach its expected state');
    await new Promise(resolve => setImmediate(resolve));
  }
};
const assertNoPersona = (host, text) => {
  for (const member of host.template.members) assert.ok(!text.includes(member.persona_prompt));
  assert.ok(!text.includes('PRIVATE_PERSONA_'));
};

test('bound launcher rejects a live workspace different from its unchanged Session header', async t => {
  const host = await launcherHost(t, applyLauncher);
  await host.ctx.workingDirectory.set(host.root, '/outside-owned-workspace');
  const result = await host.invoke('launch');
  assert.match(result.text, /WRONG_WORKSPACE/);
  assert.equal(host.counts().spawnAttempts, 0); assert.deepEqual(host.writes, []);
});

test('bound launcher rechecks live workspace across model preflight before any write', async t => {
  const host = await launcherHost(t, applyLauncher, { resolveCallConfig: async route => {
    await host.ctx.workingDirectory.set(host.root, '/outside-owned-workspace'); return route;
  } });
  const result = await host.invoke('launch');
  assert.match(result.text, /WRONG_WORKSPACE/);
  assert.equal(host.counts().spawnAttempts, 0); assert.deepEqual(host.writes, []);
});

test('fresh disabled root creates two native routes, presets, task dependencies and exact startup tool masks', async t => {
  const host = await launcherHost(t, applyLauncher, { rawEnabledMissing: true });
  assert.throws(() => host.board.listTasks(host.root), { code: 'TEAM_DISABLED' });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'success', result.text);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.mode, 'launch');
  assert.match(result.value.templateFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(modeWrites(host), [true]);
  assert.equal(result.value.team.priorMode, false);
  assert.equal(result.value.team.currentMode, true);
  assert.equal(host.catalog.size, 2);
  assert.equal(host.presets.size, 2, 'startup teardown retains native continuation presets');
  assert.deepEqual(host.removedPresets, []);
  assert.equal(result.value.scopedDelegationToolDisposed, true);
  assert.equal(hookCount(host), 0, 'startup root quarantine ends after startup drain');
  assert.deepEqual(new Set(result.value.members.map(row => row.route.model)), new Set(['deepseek-flash', 'deepseek-v4-pro']));
  for (const row of result.value.members) {
    const spec = host.template.members.find(member => member.name === row.name);
    assert.equal(row.agentPreset, spec.agent_preset);
    assert.deepEqual([...row.tools].sort(), [...spec.native_tool_allowlist].sort());
    assert.equal(row.ended, true);
    assert.deepEqual(row.scopeDenials, []);
    assert.equal(row.route.maxTokens, 1024);
    const evidence = result.value.gate.roles[row.name];
    assert.ok(evidence.admissions > 0);
    assert.ok(evidence.usage.totalTokens > 0);
  }
  assert.ok(host.order.indexOf('preflight:deepseek-flash') < host.order.indexOf('spawn:reviewer'));
  assert.ok(host.order.indexOf('preflight:deepseek-v4-pro') < host.order.indexOf('spawn:reviewer'));
  const [implementation, review] = result.value.tasks;
  assert.equal(implementation.status, 'completed');
  assert.equal(review.status, 'completed');
  assert.deepEqual(review.blockedBy, [implementation.id]);
  const memberIds = new Set(result.value.members.map(row => row.id));
  assert.ok(result.value.tasks.every(task => memberIds.has(task.ownerId)));
  assert.ok(host.writes.filter(write => write.kind === 'update').every(write => memberIds.has(write.callerId)));
  assert.equal(host.writes.some(write => write.action === 'reassign'), false);
  assert.deepEqual(new Set(result.value.cancelledParentNoticeIds), new Set(['notice-reviewer', 'notice-implementer']));
  assert.equal(host.noticesRemoved.length, 2);
  assert.deepEqual(host.root.inbox.nextStep, []);
  assert.deepEqual(host.root.inbox.nextTurn, []);
  assert.equal(host.providerCalls.some(call => call.id === host.root.id), false);
  assert.equal(host.order.some(item => item.startsWith('interrupt:')), false, 'normal native disposed settlement needs no post-end interrupt');
  assertNoPersona(host, result.text);
});

test('startup may finish while seeded business tasks remain pending', async t => {
  const host = await launcherHost(t, applyLauncher, { pendingStartup: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'success', result.text);
  assert.equal(result.value.ok, true);
  assert.deepEqual(result.value.tasks.map(task => task.status), ['pending', 'pending']);
  assert.equal(host.writes.some(write => write.kind === 'update'), false);
  assert.equal(host.counts().providerCalls, 2);
  assert.equal(host.order.some(item => item.startsWith('interrupt:')), false);
  assert.equal(hookCount(host), 0);
});

test('native catalog presence with unobservable persona blocks repeat launch without any mutation or wake', async t => {
  const host = await launcherHost(t, applyLauncher, { pendingStartup: true });
  assert.equal((await host.invoke('launch')).kind, 'success');
  const before = host.counts(), writes = structuredClone(host.writes);
  const planned = decode(await host.invoke('plan'));
  assert.equal(planned.kind, 'success');
  assert.equal(planned.value.ok, false);
  assert.equal(planned.value.plan.blocked, true);
  assert.ok(planned.value.plan.members.every(member => member.action === 'conflict' && member.unverifiableFields.includes('personaPrompt')));
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.code, 'LAUNCHER_MEMBER_CONFLICT');
  assert.equal(result.value.catalogReason, 'NATIVE_CATALOG_COMPLETE');
  assert.deepEqual(result.value.plan, planned.value.plan);
  assert.ok(result.value.plan.members.every(member => member.childId === [...host.catalog.values()].find(row => row.name === member.name).id));
  assert.equal(result.value.persistenceUnconfirmed, false);
  assert.equal(result.value.reconciliationRequired, false);
  assert.equal(result.value.teamModeRestored, false);
  assert.equal(Object.hasOwn(result.value, 'observation'), false);
  assert.equal(Object.hasOwn(result.value, 'observations'), false);
  assert.deepEqual(host.counts(), before);
  assert.deepEqual(host.writes, writes);
  assert.equal(host.catalog.size, 2);
  assert.equal(host.presets.size, 2);
  assert.equal(hookCount(host), 0);
  assertNoPersona(host, planned.text + result.text);
});

test('second native activation failure retains first session and new tasks and restores mode only after settlement', async t => {
  const host = await launcherHost(t, applyLauncher, { failSecondCreate: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.code, 'NATIVE_DELEGATION_FAILED', result.text);
  assert.equal(result.value.delegationFailure.nativeError.code, 'FIXTURE_CREATE_FAILED');
  assert.equal(result.value.delegationFailure.nativeError.messageRedacted, true);
  assert.equal(result.value.teamModeRestored, true);
  assert.equal(result.value.reconciliationRequired, false);
  assert.equal(result.value.persistenceUnconfirmed, false);
  assert.deepEqual(modeWrites(host), [true, false]);
  assert.equal(host.catalog.size, 1, 'successful native child session is retained');
  assert.equal(host.tasks.size, 2, 'new task records are retained');
  assert.equal(host.presets.size, 2);
  assert.ok(host.order.indexOf('end:reviewer') < host.order.indexOf('mode:false'));
  assert.ok(host.order.indexOf('end:reviewer') < host.order.indexOf('native-tool-disposed'));
  assert.equal(host.noticesRemoved.length, 1);
  assert.equal(hookCount(host), 0);
  assertNoPersona(host, result.text);
});

test('unconfirmed task persistence preserves committed records and stops subsequent mode writes', async t => {
  const host = await launcherHost(t, applyLauncher, { persistenceFailure: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.persistenceUnconfirmed, true);
  assert.equal(result.value.reconciliationRequired, true);
  assert.ok(result.value.reconciliationReasons.includes('TEAM_TASK_CREATE_UNCONFIRMED'));
  assert.equal(result.value.teamModeRestored, false);
  assert.deepEqual(modeWrites(host), [true]);
  assert.equal(host.tasks.size, 2);
  assert.equal(host.counts().spawnAttempts, 0);
  assert.equal(host.counts().providerCalls, 0);
  assert.equal(hookCount(host), 0);
});

test('foreign board drift during native enable await stops before own task creation or mode rollback', async t => {
  const host = await launcherHost(t, applyLauncher, { enableDrift: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.reconciliationRequired, true);
  assert.ok(result.value.reconciliationReasons.includes('TEAM_BOARD_CONCURRENT_CHANGE'));
  assert.deepEqual(modeWrites(host), [true]);
  assert.equal(host.counts().taskCreates, 0);
  assert.equal(host.counts().spawnAttempts, 0);
  assert.equal(host.tasks.get('task-foreign').description, 'Unrelated work');
  assert.equal(hookCount(host), 0);
});

test('foreign mode change during startup is preserved with no later mode write', async t => {
  const host = await launcherHost(t, applyLauncher, { modeDrift: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.reconciliationRequired, true);
  assert.ok(result.value.reconciliationReasons.includes('TEAM_MODE_CONCURRENT_CHANGE'));
  assert.deepEqual(modeWrites(host), [true]);
  assert.equal(host.board.isEnabled(host.root), false);
  assert.equal(host.tasks.size, 2);
  assert.equal(host.writes.some(write => write.kind === 'update'), false);
  assert.equal(hookCount(host), 0);
});

test('native ask approval wait happens after pre-execute and final guard rejects changed task before body', async t => {
  const host = await launcherHost(t, applyLauncher, { askTaskDrift: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.ok(host.order.includes('native-approval-wait'));
  assert.ok(host.order.includes('native-approval-allowed'));
  assert.equal(host.bodyCalls.some(call => call.role === 'implementer' && call.action === 'claim'), false);
  const implementation = [...host.tasks.values()].find(task => task.subject.startsWith('Implement'));
  assert.equal(implementation.status, 'pending');
  assert.equal(implementation.revision, 2);
  assert.deepEqual(implementation.writeScopes, ['foreign-scope']);
  assert.equal(result.value.reconciliationRequired, true);
  assert.ok(result.value.reconciliationReasons.includes('TEAM_BOARD_CONCURRENT_CHANGE'));
  assert.deepEqual(modeWrites(host), [true]);
  assert.ok(result.value.members.some(member => member.scopeDenials.length > 0));
  assert.equal(hookCount(host), 0);
});

test('policy refusal and resolved-control drift both happen before native mutation or child activation', async t => {
  for (const options of [{ unauthorized: true }, { resolvedCapDrift: true }]) {
    const host = await launcherHost(t, applyLauncher, options);
    const result = decode(await host.invoke('launch'));
    assert.equal(result.kind, 'error');
    assert.equal(result.value.code, options.unauthorized ? 'SESSION_ROUTE_NOT_AUTHORIZED' : 'RESOLVED_CONTROLS_CHANGED');
    assert.deepEqual(host.writes, []);
    assert.equal(host.counts().spawnAttempts, 0);
    assert.equal(host.counts().providerCalls, 0);
    assert.equal(host.preflights.length, options.unauthorized ? 0 : 1);
    assert.equal(hookCount(host), 0);
  }
});

test('timeout and unload retain closed startup guards until uninterruptible child lifecycles settle', async t => {
  const host = await launcherHost(t, applyLauncher, { hang: true, throwInterrupt: true });
  const running = host.invoke('launch');
  await eventually(() => host.children.size === 2 && host.providerCalls.length === 2);
  const result = decode(await running);
  assert.equal(result.kind, 'error');
  assert.equal(result.value.code, 'TIMEOUT_DRAINING_GUARD_RETAINED', result.text);
  assert.equal(hookCount(host), 1);
  assert.equal(host.presets.size, 2);
  let providerBody = 0;
  const hook = [...host.hooks.get('llm/stream')][0];
  const child = [...host.children.values()][0];
  await assert.rejects(async () => {
    for await (const _ of hook({ ...child.route, sessionId: child.agent.id, maxTokens: 1024, messages: child.history,
      tools: [...child.visible].map(name => ({ name })) }, async function* () { providerBody++; })) {}
  }, { code: 'TEAM_GATE_CLOSED' });
  assert.equal(providerBody, 0);
  let unloaded = false;
  const unloading = host.dispose().then(() => { unloaded = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unloaded, false);
  assert.equal(hookCount(host), 1);
  assert.equal(host.order.includes('native-tool-disposed'), false);
  host.release();
  await unloading;
  assert.equal(hookCount(host), 0);
  assert.equal(host.presets.size, 0);
  assert.ok(host.order.indexOf('native-tool-disposed') > host.order.indexOf('end:reviewer'));
  assert.ok(host.order.indexOf('native-tool-disposed') > host.order.indexOf('end:implementer'));
});

test('native disposed settlement permits restore from exact original idle handles and unchanged board', async t => {
  const host = await launcherHost(t, applyLauncher, { pendingStartup: true });
  assert.equal((await host.invoke('launch')).kind, 'success');
  assert.equal(host.agents.size, 1, 'native exact first ends naturally unregister both child handles');
  assert.ok([...host.children.values()].every(child => child.ended && child.agent.status === 'idle'));
  const before = host.counts();
  const restored = decode(await host.invoke('restore'));
  assert.equal(restored.kind, 'success', restored.text);
  assert.equal(restored.value.teamModeRestored, true);
  assert.deepEqual(new Set(restored.value.retainedChildIds), new Set(host.catalog.keys()));
  assert.deepEqual(new Set(restored.value.retainedTaskIds), new Set(host.tasks.keys()));
  assert.deepEqual(modeWrites(host), [true, false]);
  assert.equal(host.catalog.size, 2);
  assert.equal(host.tasks.size, 2);
  assert.equal(host.presets.size, 2);
  assert.equal(host.counts().spawnAttempts, before.spawnAttempts);
  assert.equal(host.counts().providerCalls, before.providerCalls);
});

test('restore with a changed board refuses all mode writes after native disposed settlement', async t => {
    const host = await launcherHost(t, applyLauncher, { pendingStartup: true });
    assert.equal((await host.invoke('launch')).kind, 'success');
    [...host.tasks.values()][0].description = 'Concurrent owner change';
    const result = decode(await host.invoke('restore'));
    assert.equal(result.kind, 'error');
    assert.equal(result.value.code, 'RESTORE_BOARD_CONFLICT');
    assert.equal(result.value.persistenceUnconfirmed, false);
    assert.equal(result.value.reconciliationRequired, true, 'full raw board drift requires reconciliation without a write');
    assert.deepEqual(modeWrites(host), [true]);
    assert.equal(host.catalog.size, 2);
    assert.equal(host.tasks.size, 2);
    assert.equal(host.presets.size, 2);
});

test('unexpected native publication during preflight metadata await blocks all mutation', async t => {
  const host = await launcherHost(t, applyLauncher, { preflightUnexpected: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.operationFailure, 'UNEXPECTED_CHILD', result.text);
  assert.equal(result.value.reconciliationRequired, true);
  assert.deepEqual(host.writes, []);
  assert.equal(host.counts().spawnAttempts, 0);
  assert.equal(host.counts().providerCalls, 0);
  assert.equal(hookCount(host), 0);
});

test('restore rejects a same-id registry replacement rather than accepting its idle fields', async t => {
  const host = await launcherHost(t, applyLauncher, { pendingStartup: true });
  assert.equal((await host.invoke('launch')).kind, 'success');
  const child = [...host.children.values()][0].agent;
  host.agents.set(child.id, { ...child });
  const result = decode(await host.invoke('restore'));
  assert.equal(result.kind, 'error');
  assert.equal(result.value.code, 'RESTORE_CHILD_NOT_IDLE', result.text);
  assert.equal(result.value.persistenceUnconfirmed, false);
  assert.equal(result.value.reconciliationRequired, false);
  assert.deepEqual(modeWrites(host), [true]);
  assert.equal(host.catalog.size, 2);
});

test('restore post-write failures report exact uncertainty, clear authority and never compensate', async t => {
  for (const [option, code, persistence] of [
    ['restoreFlushDrift', 'RESTORE_BOARD_CONFLICT', false],
    ['restoreFailure', 'RESTORE_PERSISTENCE_UNCONFIRMED', true],
    ['restoreModeMismatch', 'RESTORE_MODE_UNCONFIRMED', true],
  ]) {
    const host = await launcherHost(t, applyLauncher, { pendingStartup: true, [option]: true });
    assert.equal((await host.invoke('launch')).kind, 'success');
    const result = decode(await host.invoke('restore'));
    assert.equal(result.kind, 'error');
    assert.equal(result.value.code, code, result.text);
    assert.equal(result.value.reconciliationRequired, true);
    assert.ok(result.value.reconciliationReasons.includes(code));
    assert.equal(result.value.persistenceUnconfirmed, persistence);
    assert.equal(result.value.teamModeRestored, false);
    assert.equal(result.value.stopFurtherMutation, true);
    assert.equal(result.value.noAutomaticRetry, true);
    assert.deepEqual(modeWrites(host), [true, false]);
    if (option === 'restoreFlushDrift') assert.equal([...host.tasks.values()][0].description, 'Concurrent restore-flush edit');
    if (option !== 'restoreModeMismatch') assert.throws(() => host.board.listTasks(host.root), { code: 'TEAM_DISABLED' });
    const retry = decode(await host.invoke('restore'));
    assert.equal(retry.value.code, 'RESTORE_AUTHORITY_UNAVAILABLE');
    assert.deepEqual(modeWrites(host), [true, false], 'no retained authority permits another write');
    assert.equal(host.catalog.size, 2);
    assert.equal(host.presets.size, 2);
    assertNoPersona(host, result.text + retry.text);
  }
});

test('native disposal ownership retains late-start guards and exact end observation until drain', async t => {
  const host = await launcherHost(t, applyLauncher, { hang: true, lateStart: true, throwInterrupt: true, cleanupTimeoutMs: 500 });
  const running = host.invoke('launch');
  await eventually(() => host.order.includes('native-publication-await'));
  const result = decode(await running);
  assert.equal(result.kind, 'error');
  assert.equal(result.value.code, 'TIMEOUT_DRAINING_GUARD_RETAINED', result.text);
  assert.equal(result.value.members.length, 1);
  assert.equal(result.value.members[0].id, null);
  assert.equal(result.value.members[0].runId, null);
  assert.equal(result.value.gate.roles.reviewer.admissions, 0);
  assert.equal(host.children.size, 0);
  assert.equal(hookCount(host), 1);
  let unloaded = false;
  const unloading = host.dispose().then(() => { unloaded = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unloaded, false);
  assert.equal(hookCount(host), 1, 'owner unload must not automatically remove the stream guard before native drain');
  assert.equal(host.hooks.get('subagent/start')?.size, 1, 'owner unload must retain the late-start observer');
  assert.equal(host.hooks.get('subagent/end')?.size, 1, 'owner unload must retain exact end observation');
  host.publishLateStart();
  await eventually(() => host.children.size === 1);
  const [id, child] = [...host.children.entries()][0];
  assert.ok(host.order.includes(`interrupt:${id}`), 'late publication still receives exact ancestor interruption');
  assert.equal(host.counts().spawnAttempts, 1, 'timeout does not spawn the second member or retry');
  assert.equal(host.catalog.size, 1, 'native partial session is retained');
  assert.equal(child.ended, false);
  assert.equal(unloaded, false);
  assert.equal(hookCount(host), 1);
  assert.equal(host.order.includes('native-tool-disposed'), false);
  await assert.rejects(host.requestChildStream(id), { code: 'UNEXPECTED_CHILD' });
  assert.equal(host.counts().providerCalls, 0, 'closed late child never reaches a provider body');
  host.emitWrongRunEnd(id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unloaded, false, 'same id with another run cannot drain this operation');
  assert.equal(hookCount(host), 1);
  host.release();
  await unloading;
  assert.equal(hookCount(host), 0);
  assert.equal(host.presets.size, 0);
  assert.equal(host.counts().spawnAttempts, 1);
  assert.equal(host.counts().providerCalls, 0);
  assert.ok(host.order.indexOf('native-tool-disposed') > host.order.indexOf('end:reviewer'));
  assert.equal(host.noticesRemoved.length, 1);
});

test('native disposal ownership automatically clears top-level hooks concurrently while yielded groups wait', async () => {
  const owner = nativeEffectOwner(), hooks = new Map(), order = [];
  let release;
  const drain = new Promise(resolve => { release = resolve; });
  owner.effect(function* () { yield async () => { order.push('early-drain'); await drain; }; });
  owner.on(hooks, 'sibling', () => {});
  owner.effect(function* () {
    yield owner.on(hooks, 'grouped', () => {});
    yield async () => { order.push('group-drain'); await drain; };
  });
  assert.equal(owner.topCount(), 3, 'yielded listener is removed from the top owner list');
  let unloaded = false;
  const unloading = owner.dispose().then(() => { unloaded = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks.get('sibling').size, 0, 'late sibling auto-removes even while early drain is pending');
  assert.equal(hooks.get('grouped').size, 1, 'structural child remains behind its group drain');
  assert.ok(order.includes('early-drain') && order.includes('group-drain'), 'top groups start concurrently');
  assert.equal(unloaded, false);
  release(); await unloading;
  assert.equal(hooks.get('grouped').size, 0);
  const secondOwner = nativeEffectOwner();
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const publicDisposer = secondOwner.effect(() => () => pending);
  const firstDisposal = publicDisposer();
  assert.equal(publicDisposer(), undefined, 'native public disposer repeat calls do not join in-flight cleanup');
  let ownerDone = false;
  const ownerDisposal = secondOwner.dispose().then(() => { ownerDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ownerDone, false, 'native internal owner joins the already-running cleanup');
  settle(); await firstDisposal; await ownerDisposal;
});

test('1066 F1 enable-await create-delete raw drift stops own writes and preserves current mode', async t => {
  const host = await launcherHost(t, applyLauncher, { enableCreateDelete: true, pendingStartup: true });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error', result.text);
  assert.equal(result.value.reconciliationRequired, true);
  assert.equal(result.value.teamModeRestored, false);
  assert.deepEqual(modeWrites(host), [true]);
  assert.equal(host.counts().taskCreates, 0);
  assert.equal(host.counts().spawnAttempts, 0);
  assert.equal(host.counts().providerCalls, 0);
  assert.deepEqual(host.board.listTasks(host.root), [], 'native visible list hides the external tombstone');
  const raw = host.ctx.sessionProjections.stateOf(host.root.session, 'agentTeam');
  assert.equal(raw.tasks.length, 1);
  assert.equal(raw.tasks[0].status, 'deleted');
  assert.equal(raw.nextTaskNumber, 2);
});

test('1066 F1 post-launch create-delete raw drift prevents restore mode write', async t => {
  const host = await launcherHost(t, applyLauncher, { pendingStartup: true });
  assert.equal((await host.invoke('launch')).kind, 'success');
  const visible = structuredClone(host.board.listTasks(host.root));
  const before = host.ctx.sessionProjections.stateOf(host.root.session, 'agentTeam');
  host.createDeleteForeign();
  assert.deepEqual(host.board.listTasks(host.root), visible);
  const raw = host.ctx.sessionProjections.stateOf(host.root.session, 'agentTeam');
  assert.equal(raw.nextTaskNumber, before.nextTaskNumber + 1);
  assert.equal(raw.tasks.length, before.tasks.length + 1);
  const result = decode(await host.invoke('restore'));
  assert.equal(result.kind, 'error', result.text);
  assert.equal(result.value.reconciliationRequired, true);
  assert.equal(result.value.teamModeRestored, false);
  assert.deepEqual(modeWrites(host), [true]);
  assert.equal(host.tasks.get(`task-${before.nextTaskNumber}`).status, 'deleted');
});

test('1066 F1 unchanged existing tombstone permits normal launch and restore with confirmed own changes', async t => {
  const host = await launcherHost(t, applyLauncher, { initialTombstone: true });
  const initial = host.ctx.sessionProjections.stateOf(host.root.session, 'agentTeam');
  const launched = decode(await host.invoke('launch'));
  assert.equal(launched.kind, 'success', launched.text);
  assert.equal(launched.value.ok, true);
  assert.equal(launched.value.tasks.length, 2);
  assert.equal(launched.value.tasks.some(task => task.status === 'deleted'), false);
  const restored = decode(await host.invoke('restore'));
  assert.equal(restored.kind, 'success', restored.text);
  const final = host.ctx.sessionProjections.stateOf(host.root.session, 'agentTeam');
  assert.deepEqual(final.tasks.find(task => task.id === initial.tasks[0].id), initial.tasks[0]);
  assert.equal(final.nextTaskNumber, initial.nextTaskNumber + 2);
  assert.equal(final.tasks.length, 3);
  assert.deepEqual(modeWrites(host), [true, false]);
});

test('1066 F2 idle ended peer is rejected before native send body and never woken', async t => {
  const host = await launcherHost(t, applyLauncher, { peerEndedBeforeSend: true, cleanupTimeoutMs: 500 });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error', result.text);
  assert.equal(host.bodyCalls.filter(call => call.name === 'send_message').length, 0,
    'native send body would wake an ended idle member instead of rejecting its identity');
  assert.equal(host.counts().wakeCalls, 0);
  assert.equal(host.newWork.length, 0);
  assert.ok(result.value.members.some(member => member.scopeDenials.some(denial => denial.reason === 'TEAM_PEER_NOT_RUNNING')));
  assert.equal(result.value.restorable, undefined);
  assert.equal(hookCount(host), 0);
});

test('1066 F2 legitimate message to a peer still working in wait_agent does not start another turn', async t => {
  const host = await launcherHost(t, applyLauncher);
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'success', result.text);
  assert.equal(result.value.restorable, true);
  assert.equal(host.bodyCalls.filter(call => call.name === 'send_message').length, 1);
  assert.equal(host.bodyCalls.filter(call => call.name === 'wait_agent').length, 1);
  assert.equal(host.counts().wakeCalls, 0);
  assert.equal(host.newWork.length, 0);
  assert.equal(host.order.filter(item => item.startsWith('turn-start:implementer:')).length, 1);
  assert.equal(host.order.filter(item => item.startsWith('turn-start:reviewer:')).length, 1);
});

for (const replacement of [false, true]) {
  test(`1066 F2 ${replacement ? 'same-id replacement' : 'new run'} cannot finish startup before actual child work is idle`, async t => {
    const host = await launcherHost(t, applyLauncher, { pendingStartup: true, throwInterrupt: true,
      [replacement ? 'replaceAfterEnd' : 'externalNewRun']: true, cleanupTimeoutMs: 500 });
    let finished = false;
    const running = host.invoke('launch').then(result => { finished = true; return result; });
    await eventually(() => host.newWork.length === 1);
    await new Promise(resolve => setImmediate(resolve));
    const work = host.newWork[0];
    assert.equal(work.agent.status, 'running');
    assert.equal(finished, false, 'first settlement cannot account for current busy work');
    assert.equal(hookCount(host), 1, 'guard must remain while actual new work is unconfirmed');
    assert.equal(host.hooks.get('subagent/end')?.size, 1);
    // A resumed native activation unregisters its new handle before exact end.
    // No foreign replacement remains permanently installed at drain.
    if (replacement) host.agents.delete(work.id);
    host.release();
    const result = decode(await running);
    assert.equal(result.kind, 'error', result.text);
    assert.equal(result.value.restorable, undefined);
    assert.equal(work.agent.status, 'idle');
    assert.equal(hookCount(host), 0);
    assert.equal(host.catalog.size, 2);
  });
}

test('1066 F2 peer ending during native ask is rejected by finalGuard before send body', async t => {
  const host = await launcherHost(t, applyLauncher, { askPeerEnds: true, cleanupTimeoutMs: 500 });
  const result = decode(await host.invoke('launch'));
  assert.equal(result.kind, 'error', result.text);
  assert.ok(host.order.includes('native-approval-wait'));
  assert.ok(host.order.includes('native-approval-allowed'));
  assert.equal(host.bodyCalls.filter(call => call.name === 'send_message').length, 0);
  assert.equal(host.counts().wakeCalls, 0);
  assert.equal(host.newWork.length, 0);
  assert.ok(result.value.members.some(member => member.scopeDenials.some(denial => denial.reason === 'TEAM_PEER_NOT_RUNNING')));
  assert.equal(result.value.restorable, undefined);
});

test('1066 F2 native send resolve await may expose a new run but cannot outlive the startup guard', async t => {
  const host = await launcherHost(t, applyLauncher, { sendPeerEndsAtResolve: true, throwInterrupt: true, cleanupTimeoutMs: 500 });
  let finished = false;
  const running = host.invoke('launch').then(result => { finished = true; return result; });
  await eventually(() => host.newWork.length === 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(host.order.includes('native-message-resolve-await'));
  assert.ok(host.order.includes('native-message-resolve-return'));
  assert.equal(host.counts().wakeCalls, 1, 'the finalGuard does not claim atomicity across native body awaits');
  assert.equal(host.bodyCalls.filter(call => call.name === 'send_message').length, 1);
  assert.equal(finished, false);
  assert.equal(hookCount(host), 1);
  assert.equal(host.newWork[0].agent.status, 'running');
  host.release();
  const result = decode(await running);
  assert.equal(result.kind, 'error', result.text);
  assert.equal(result.value.restorable, undefined);
  assert.equal(hookCount(host), 0);
  assert.equal(host.newWork[0].agent.status, 'idle');
});

test('1066 F2 same-running-phase second native turn is stopped before another provider body and drains exact lifecycle', async t => {
  const host = await launcherHost(t, applyLauncher, { samePhaseSecondTurn: true, throwInterrupt: true, cleanupTimeoutMs: 500 });
  let finished = false;
  const running = host.invoke('launch').then(result => { finished = true; return result; });
  await eventually(() => host.order.includes('same-phase-second-turn-return'));
  const reviewer = [...host.children.values()].find(child => child.role === 'reviewer');
  assert.equal(reviewer.agent.status, 'running');
  assert.equal(host.order.filter(item => item.startsWith('turn-start:reviewer:')).length, 2);
  assert.equal(host.providerCalls.filter(call => call.role === 'reviewer').length, 1,
    'fresh successful tool result must not let a second turn borrow ordinary stream budget');
  assert.equal(finished, false);
  assert.equal(hookCount(host), 1);
  assert.equal(host.catalog.size, host.children.size, 'no fake subagent/start was emitted for the second turn');
  host.release();
  const result = decode(await running);
  assert.equal(result.kind, 'error', result.text);
  assert.equal(result.value.restorable, undefined);
  assert.equal(hookCount(host), 0);
  const evidence = result.value.members.find(member => member.name === 'reviewer');
  assert.deepEqual(evidence.turnStarts, [1, 2]);
  assert.equal(evidence.additionalTurns, 1);
});
