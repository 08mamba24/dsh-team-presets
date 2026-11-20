import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, LiveError } from './config.js';
import { parseTeamConfig, authorizeTeam, preflightTeam, TEAM_ROLE_TOOLS } from './team-config.js';
import { createTeamGate } from './team-gate.js';
import { isHostControlPath } from './host-support.js';

const ROLES = ['implementer', 'reviewer'];
const TOOL = 'dsh_live_team_spawn';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pending = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn];
const json = value => JSON.stringify(value);
const textOf = blocks => (blocks ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
const reconcile = (op, code) => {
  op.reconciliationRequired = true;
  op.reconciliationReasons ??= [];
  if (!op.reconciliationReasons.includes(code)) op.reconciliationReasons.push(code);
};
const conflict = (op, code) => { reconcile(op, code); fail(code); };
const taskState = task => ({ id: task.id, revision: task.revision, ownerId: task.ownerId ?? null,
  status: task.status, subject: task.subject, description: task.description,
  blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] });

export function checkedControlEntry(entry) {
  try {
    if (!entry || Object.keys(entry).sort().join(',') !== 'config,name' || typeof entry.name !== 'string'
      || !entry.config || Object.keys(entry.config).join(',') !== 'interrupt' || entry.config.interrupt !== false) throw new Error();
    const url = new URL(entry.name), path = fileURLToPath(url, { windows: process.platform === 'win32' });
    if (url.protocol !== 'file:' || url.host || url.search || url.hash
      || !isHostControlPath(path, 'lib/index.js')) throw new Error();
    return { name: entry.name, config: { interrupt: false } };
  } catch { fail('NATIVE_CONTROL_ENTRY_UNAVAILABLE'); }
}

function boundedNativeError(result) {
  if (result?.isError !== true || !result.error || typeof result.error !== 'object') return;
  const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
    && !/(?:token|secret|password|credential|authorization|bearer|api[_.-]?key|^sk[_.-])/i.test(value) ? value : undefined;
  const name = identifier(result.error.info?.name), code = identifier(result.error.info?.code);
  let message = 'Native error message omitted';
  // Never forward unknown text, URLs, headers, query strings, content, reason, stack, or prompts.
  if (typeof result.error.message === 'string' && /^tools\.restrict\(\) names unknown global tools?\b/.test(result.error.message)) {
    const prefix = result.error.message.split(';', 1)[0];
    const unknown = TEAM_ROLE_TOOLS.filter(tool => prefix.includes(`"${tool}"`));
    message = unknown.length ? `tools.restrict() names unknown global tools: ${unknown.join(', ')}` : 'Native tool restriction named unknown global tools';
  }
  return { ...(name ? { name } : {}), ...(code ? { code } : {}), message, messageRedacted: true };
}

export function delegationFailure(batch, child, role, memberName) {
  const first = batch?.results?.[0], result = first?.result;
  const checks = [
    ['RESULT_COUNT', batch?.results?.length !== 1],
    ['CALL_ID', first?.callId !== child.callId],
    ['RESULT_ERROR_FLAG', result?.isError !== false],
    ['ACTIVATION_KIND', result?.value?.kind !== 'activation'],
    ['ACTIVATION_NAME', result?.value?.name !== memberName],
    ['ADDITIONAL_CONTEXTS', batch?.additionalContexts?.length !== 0],
    ['CONCLUDED_FLAG', batch?.concluded !== false],
  ];
  const mismatches = checks.filter(([, failed]) => failed).map(([code]) => code);
  if (mismatches.length === 0) return;
  const count = value => Number.isSafeInteger(value?.length) && value.length >= 0 ? value.length : null;
  const nativeError = boundedNativeError(result);
  return { role, mismatches, batchResult: { resultCount: count(batch?.results), callIdMatches: first?.callId === child.callId,
    isError: typeof result?.isError === 'boolean' ? result.isError : null,
    activationKindMatches: result?.value?.kind === 'activation', activationNameMatches: result?.value?.name === memberName,
    additionalContextCount: count(batch?.additionalContexts), concluded: typeof batch?.concluded === 'boolean' ? batch.concluded : null },
  ...(nativeError ? { nativeError } : {}) };
}

/** A separate marker and command keep the accepted M1 path inert and unchanged. */
async function assertTeamOwned(ctx, config, agent) {
  if (process.platform === 'win32') fail('LEGACY_BOUND_ENTRY_REQUIRES_MACOS');
  if (!agent || agent.id !== config.ownedSessionId || agent.session?.id !== agent.id
    || ctx.agents.get(agent.id) !== agent || agent.session.header?.origin === 'subagent') fail('WRONG_AGENT');
  if (await realpath(config.workspace) !== config.workspace
    || await realpath(agent.session.header.cwd) !== config.workspace) fail('WRONG_WORKSPACE');
  const path = join(config.workspace, '.dsh-team-live.json'), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
    || before.uid !== process.getuid() || before.size > 4096) fail('INVALID_MARKER');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(), marker = JSON.parse(await file.readFile('utf8'));
    if (stat.ino !== before.ino || stat.dev !== before.dev || marker.purpose !== 'dsh-native-team-pair'
      || marker.ownedSessionId !== config.ownedSessionId || marker.runTag !== config.runTag) fail('INVALID_MARKER');
  } finally { await file.close(); }
}

function promptFor(role, config, tasks) {
  const own = tasks[role].id, implementation = tasks.implementer.id;
  const result = { role, value: 5, completedTaskIds: [own] };
  const final = `Your final answer must be only JSON with ${json(result).slice(1, -1)}, and personaNonce from your system persona. Never copy a nonce from another role. Do not delegate, use files or shell, or message the Lead. No retries on tool, CAS, delivery or persistence failure: stop and report the error.`;
  if (role === 'implementer') return `Run ${config.runTag}. You own the implementation, not the review. `
    + `Use team_task_get for task ${own}; claim it with the returned revision. Compute 2+3. `
    + `Use team_task_update edit, with the revision returned by claim, to set description to the exact JSON ${json({ runTag: config.runTag, role, value: 5 })}. `
    + `Complete it with the revision returned by edit. Only after completion send_message to agent ${json(config.roles.reviewer.memberName)} `
    + `with message equal to ${json({ runTag: config.runTag, implementationTaskId: implementation, value: 5 })}. `
    + `Use each returned revision directly; do not add unnecessary reads. ${final}`;
  return `Run ${config.runTag}. You own the review, not the implementation. Your first tool call must be wait_agent({timeout_ms:30000}); `
    + `wait for the implementer's inbox message, never resolve or send to a member that has not been created. `
    + `After the message arrives, use team_task_get for ${implementation} and ${own} in the same step. `
    + `Verify the implementation is completed and its description JSON has runTag=${json(config.runTag)}, role=implementer, value=5; `
    + `verify the inbox handoff agrees. Claim your now-ready task using its current revision, then complete it using the revision returned by claim. `
    + `Do not edit tasks or send another message. Include reviewedTaskId=${json(implementation)} and verdict="approved" in your final JSON. ${final}`;
}

function recordChildEvents(child, record, op, onToolResult, toolGuard) {
  const disposers = [];
  disposers.push(child.ctx.on('tools/pre-execute', toolGuard.preExecute));
  disposers.push(child.ctx.tools.guard(toolGuard.finalGuard));
  disposers.push(child.ctx.on('session/event', (session, event) => {
    if (session.id !== record.id) return;
    if (event.type === 'tool/call') {
      const data = event.data;
      let args;
      try { args = JSON.parse(data.arguments); } catch { op.failure ??= 'TEAM_TOOL_ARGUMENTS_INVALID'; onToolResult(undefined, false); return; }
      record.calls.push({ callId: data.callId, name: data.name, args });
    } else if (event.type === 'tool/result') {
      const message = event.data.message;
      const succeeded = message.isError === undefined || message.isError === false;
      record.results.set(message.toolCallId, succeeded);
      onToolResult(record.calls.find(c => c.callId === message.toolCallId), succeeded);
    }
  }));
  disposers.push(child.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent !== child || message.source?.kind !== 'agent-message') return;
    record.messages.push({ id: message.id, senderSessionId: message.source.senderSessionId,
      targetSessionId: child.id, content: structuredClone(message.content) });
  }));
  return () => { for (const dispose of disposers) dispose(); };
}

function validateWorkflow(config, op, role, task) {
  const child = op.children[role], calls = child.calls;
  if (calls.length === 0 || calls.some(c => child.results.get(c.callId) !== true)) fail('TEAM_TOOL_RESULTS_INCOMPLETE');
  const updates = calls.filter(c => c.name === 'team_task_update');
  const actions = role === 'implementer' ? ['claim', 'edit', 'complete'] : ['claim', 'complete'];
  if (json(updates.map(c => c.args.action)) !== json(actions)
    || updates.some(c => c.args.task_id !== task.id || !Number.isSafeInteger(c.args.expected_revision))) conflict(op, 'TEAM_TASK_WORKFLOW_INVALID');
  const read = calls.find(c => c.name === 'team_task_get' && c.args.task_id === task.id);
  if (!read || calls.indexOf(read) > calls.indexOf(updates[0])) fail('TEAM_TASK_READ_NOT_PROVEN');
  if (updates.some((c, i) => c.args.expected_revision !== i + 1)) conflict(op, 'TEAM_TASK_REVISION_CHANGED');
  if (role === 'implementer') {
    const sends = calls.filter(c => c.name === 'send_message');
    if (sends.length !== 1 || sends[0].args.agent !== config.roles.reviewer.memberName
      || calls.indexOf(sends[0]) < calls.indexOf(updates[2])) fail('TEAM_HANDOFF_NOT_PROVEN');
    let content;
    try { content = JSON.parse(sends[0].args.message); } catch { fail('TEAM_HANDOFF_INVALID'); }
    if (content.runTag !== config.runTag || content.implementationTaskId !== task.id || content.value !== 5) fail('TEAM_HANDOFF_INVALID');
  } else {
    if (calls[0]?.name !== 'wait_agent' || calls.filter(c => c.name === 'wait_agent').length !== 1
      || !calls.some(c => c.name === 'team_task_get' && c.args.task_id === op.tasks.implementer.id)
      || calls.some(c => c.name === 'send_message')) fail('TEAM_REVIEW_WORKFLOW_INVALID');
  }
}

/** Two native children, native task CAS, and model-authored peer delivery. No task store is added. */
export async function applyTeam(ctx, raw, nativeSubagent, nativeControlEntry) {
  const config = parseTeamConfig(raw);
  if (!config) {
    ctx.commands.register({ name: 'dsh-team-live', description: 'Unconfigured native pair',
      input: { hint: 'run-pair', attachments: false }, handler: async () => ({ kind: 'error', text: 'NOT_CONFIGURED' }) });
    return;
  }
  const controlEntry = checkedControlEntry(nativeControlEntry);
  if (typeof nativeSubagent?.apply !== 'function' || typeof ctx.sessionProjections?.stateOf !== 'function'
    || typeof ctx.agentPresets?.register !== 'function' || typeof ctx.subagents?.interrupt !== 'function'
    || ['isEnabled', 'setEnabled', 'createTask', 'getTask', 'listTasks'].some(k => typeof ctx.agentTeams?.[k] !== 'function')) fail('HOST_CONTRACT_UNAVAILABLE');
  const gate = createTeamGate(config), unregister = [];
  let active, spent = false, closing = false;
  try {
    for (const role of ROLES) unregister.push(await ctx.agentPresets.register({ id: config.roles[role].presetId,
      name: `Owned native team ${role}`, plugins: [
        { id: `${config.roles[role].presetId}-native-control`, name: controlEntry.name, config: { ...controlEntry.config } },
        { id: `${config.roles[role].presetId}-persona`,
        name: 'dsh-subagent-live-rc2-local/team-role', config: { ownedSessionId: config.ownedSessionId,
          runTag: config.runTag, role, personaNonce: config.roles[role].personaNonce } }] }));
  } catch (error) { for (const dispose of unregister.reverse()) await dispose(); throw error; }

  const stopAdmission = (op, reason) => {
    gate.close(reason);
    if (op) op.admissionClosed ??= reason;
  };
  function interrupt(op, child) {
    if (!child.id || child.ended) return;
    try { ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: op.agent }); }
    catch { stopAdmission(op, 'CHILD_INTERRUPT_FAILED'); op.interruptFailed = true; op.failure ??= 'CHILD_INTERRUPT_FAILED'; }
  }
  const projection = (agent, op) => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'agentTeam');
    if (!state) conflict(op, 'TEAM_PROJECTION_UNAVAILABLE');
    if (state.failure) conflict(op, 'TEAM_PROJECTION_FAILED');
    return state;
  };
  const unchangedBaseline = op => {
    projection(op.agent, op);
    if (op.teamEnabled && !ctx.agentTeams.isEnabled(op.agent)) conflict(op, 'TEAM_MODE_CONCURRENT_CHANGE');
    const all = ctx.agentTeams.listTasks(op.agent), own = Object.values(op.tasks).map(t => t.id);
    if (json(all.filter(t => !own.includes(t.id)).map(taskState)) !== json(op.baselineTasks)) conflict(op, 'TEAM_BOARD_CONCURRENT_CHANGE');
    return all;
  };
  const restorationAuthority = op => {
    const board = unchangedBaseline(op);
    for (const [role, task] of Object.entries(op.tasks)) {
      let actual;
      try { actual = taskState(ctx.agentTeams.getTask(op.agent, task.id)); }
      catch { conflict(op, 'TEAM_TASK_STATE_UNAVAILABLE'); }
      if (!op.confirmedTasks[role] || json(actual) !== json(op.confirmedTasks[role])) conflict(op, 'TEAM_TASK_STATE_CONCURRENT_CHANGE');
    }
    return board;
  };
  function confirmTaskUpdate(op, record, call) {
    if (call?.name !== 'team_task_update') return;
    try {
      const before = op.confirmedTasks[record.role], args = call.args;
      if (!before || record.scopeReservations.get(`update:${args.action}`) !== call.callId
        || args.task_id !== before.id || args.expected_revision !== before.revision) throw new Error('unconfirmed native update');
      const expected = structuredClone(before); expected.revision++;
      if (args.action === 'claim') { expected.status = 'in_progress'; expected.ownerId = record.id; }
      else if (args.action === 'edit') expected.description = args.description;
      else if (args.action === 'complete') expected.status = 'completed';
      else throw new Error('unconfirmed native action');
      const actual = taskState(ctx.agentTeams.getTask(op.agent, before.id));
      if (json(actual) !== json(expected)) throw new Error('native result does not match the admitted transition');
      op.confirmedTasks[record.role] = expected;
    } catch {
      reconcile(op, 'TEAM_TASK_STATE_UNCONFIRMED'); op.failure ??= 'TEAM_TASK_STATE_UNCONFIRMED';
      stopAdmission(op, op.failure);
      for (const other of Object.values(op.children)) interrupt(op, other);
    }
  }
  function consumeNotices(op) {
    const children = Object.values(op.children).filter(c => c.id), queued = pending(op.agent);
    if (queued.length !== children.length || children.some(c => queued.filter(m =>
      m.source?.kind === 'subagent-settled' && m.source.senderSessionId === c.id).length !== 1)) conflict(op, 'ROOT_INBOX_CHANGED');
    const ids = queued.map(m => m.id);
    for (const id of ids) if (!op.agent.inbox.remove(id)) conflict(op, 'NOTICE_CANCELLATION_FAILED');
    if (pending(op.agent).length !== 0) conflict(op, 'ROOT_INBOX_CHANGED');
    return ids;
  }
  function toolGuardFor(op, record, child) {
    const ownId = op.tasks[record.role].id, implementationId = op.tasks.implementer.id;
    const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && Object.keys(value).every(k => keys.includes(k));
    const validate = (exec, reserved) => {
      const args = exec.arguments;
      const deny = reason => {
        op.failure ??= 'TEAM_TOOL_SCOPE_DENIED';
        if (reason !== 'TEAM_OPERATION_CANCELLED' && reason !== 'TEAM_RUN_NOT_ADMITTING') reconcile(op, 'TEAM_TOOL_SCOPE_DENIED');
        if (!record.scopeDenials.some(d => d.callId === exec.callId)) record.scopeDenials.push({ callId: exec.callId, name: exec.name, reason });
        stopAdmission(op, op.failure);
        return { kind: 'deny', reason, info: { name: 'DshTeamScopeError', code: 'TEAM_TOOL_SCOPE_DENIED' } };
      };
      if (exec.signal.aborted || op.controller.signal.aborted || op.signal?.aborted) return deny('TEAM_OPERATION_CANCELLED');
      if (closing || gate.evidence().closed || active !== op || op.children[record.role] !== record || record.ended || op.failure
        || ctx.agents.get(child.id) !== child) return deny('TEAM_RUN_NOT_ADMITTING');
      try { unchangedBaseline(op); }
      catch (error) { op.failure ??= error.code ?? 'TEAM_BOARD_UNAVAILABLE'; return deny(op.failure); }
      const successful = record.calls.filter(c => record.results.get(c.callId) === true);
      const did = (name, predicate = () => true) => successful.some(c => c.name === name && predicate(c.args));
      const updates = successful.filter(c => c.name === 'team_task_update');
      const peerPresent = () => {
        if (record.messages.length !== 1 || record.messages[0].senderSessionId !== op.children.implementer?.id) return false;
        try {
          const message = JSON.parse(record.messages[0].content.filter(b => b.type === 'text').at(-1)?.text);
          return exact(message, ['runTag', 'implementationTaskId', 'value']) && message.runTag === config.runTag
            && message.implementationTaskId === implementationId && message.value === 5;
        } catch { return false; }
      };
      const implementationUnchanged = () => {
        try {
          const task = ctx.agentTeams.getTask(child, implementationId), description = JSON.parse(task.description);
          return task.status === 'completed' && task.ownerId === op.children.implementer?.id && task.revision === 4
            && task.subject === op.tasks.implementer.subject && task.blockedBy.length === 0 && task.writeScopes.length === 0
            && exact(description, ['runTag', 'role', 'value']) && description.runTag === config.runTag
            && description.role === 'implementer' && description.value === 5;
        } catch { return false; }
      };
      let ownTask;
      try { ownTask = taskState(ctx.agentTeams.getTask(child, ownId)); }
      catch { reconcile(op, 'TEAM_TASK_STATE_UNAVAILABLE'); return deny('TEAM_TASK_STATE_UNAVAILABLE'); }
      if (json(ownTask) !== json(op.confirmedTasks[record.role])) {
        reconcile(op, 'TEAM_TASK_STATE_CONCURRENT_CHANGE'); return deny('TEAM_TASK_STATE_CONCURRENT_CHANGE');
      }
      let reservation;
      if (exec.name === 'wait_agent') {
        if (record.role !== 'reviewer' || successful.length !== 0
          || !exact(args, ['timeout_ms']) || args.timeout_ms !== 30000) return deny('TEAM_WAIT_OUT_OF_SCOPE');
        reservation = 'wait';
      } else if (exec.name === 'team_task_get') {
        if (!exact(args, ['task_id']) || updates.length !== 0
          || (args.task_id !== ownId && !(record.role === 'reviewer' && args.task_id === implementationId))) return deny('TEAM_TASK_READ_OUT_OF_SCOPE');
        if (record.role === 'reviewer' && (!did('wait_agent') || !peerPresent())) return deny('TEAM_REVIEW_HANDOFF_REQUIRED');
        if (record.role === 'reviewer' && !implementationUnchanged()) {
          reconcile(op, 'TEAM_IMPLEMENTATION_CONCURRENT_CHANGE'); return deny('TEAM_IMPLEMENTATION_CONCURRENT_CHANGE');
        }
        reservation = `get:${args.task_id}`;
      } else if (exec.name === 'team_task_update') {
        const actions = record.role === 'implementer' ? ['claim', 'edit', 'complete'] : ['claim', 'complete'];
        const expectedAction = actions[updates.length];
        const keys = expectedAction === 'edit' ? ['task_id', 'expected_revision', 'action', 'description'] : ['task_id', 'expected_revision', 'action'];
        if (!exact(args, keys) || args.task_id !== ownId || args.action !== expectedAction
          || !Number.isSafeInteger(args.expected_revision) || !did('team_task_get', a => a.task_id === ownId)) return deny('TEAM_TASK_WRITE_OUT_OF_SCOPE');
        if (record.role === 'reviewer' && (!did('team_task_get', a => a.task_id === implementationId) || !peerPresent())) return deny('TEAM_REVIEW_HANDOFF_REQUIRED');
        if (record.role === 'reviewer' && !implementationUnchanged()) {
          reconcile(op, 'TEAM_IMPLEMENTATION_CONCURRENT_CHANGE'); return deny('TEAM_IMPLEMENTATION_CONCURRENT_CHANGE');
        }
        let task;
        try { task = ctx.agentTeams.getTask(child, ownId); }
        catch { reconcile(op, 'TEAM_TASK_STATE_UNAVAILABLE'); return deny('TEAM_TASK_STATE_UNAVAILABLE'); }
        const expectedRevision = updates.length + 1;
        if (task.revision !== expectedRevision || (expectedAction === 'claim'
          ? task.status !== 'pending' || task.ownerId !== undefined || task.ready !== true
          : task.status !== 'in_progress' || task.ownerId !== child.id)) {
          reconcile(op, 'TEAM_TASK_STATE_CONCURRENT_CHANGE'); return deny('TEAM_TASK_STATE_CONCURRENT_CHANGE');
        }
        if (args.expected_revision !== task.revision) return deny('TEAM_TASK_REVISION_OUT_OF_SCOPE');
        if (expectedAction === 'edit') {
          let description;
          try { description = JSON.parse(args.description); } catch { return deny('TEAM_TASK_RESULT_OUT_OF_SCOPE'); }
          if (!exact(description, ['runTag', 'role', 'value']) || description.runTag !== config.runTag
            || description.role !== 'implementer' || description.value !== 5) return deny('TEAM_TASK_RESULT_OUT_OF_SCOPE');
        }
        reservation = `update:${expectedAction}`;
      } else if (exec.name === 'send_message') {
        if (record.role !== 'implementer' || !exact(args, ['agent', 'message'])
          || args.agent !== config.roles.reviewer.memberName || !did('team_task_update', a => a.action === 'complete')) return deny('TEAM_MESSAGE_OUT_OF_SCOPE');
        let message;
        try { message = JSON.parse(args.message); } catch { return deny('TEAM_MESSAGE_OUT_OF_SCOPE'); }
        if (!exact(message, ['runTag', 'implementationTaskId', 'value']) || message.runTag !== config.runTag
          || message.implementationTaskId !== implementationId || message.value !== 5) return deny('TEAM_MESSAGE_OUT_OF_SCOPE');
        const task = ctx.agentTeams.getTask(child, ownId);
        if (task.status !== 'completed' || task.ownerId !== child.id || task.revision !== 4) {
          reconcile(op, 'TEAM_TASK_STATE_CONCURRENT_CHANGE'); return deny('TEAM_TASK_STATE_CONCURRENT_CHANGE');
        }
        reservation = 'send';
      } else {
        // The native list tool cannot filter by this run's task ids. Keep unrelated task content out of the child.
        return deny('TEAM_TOOL_OUT_OF_SCOPE');
      }
      if (reserved ? record.scopeReservations.get(reservation) !== exec.callId : record.scopeReservations.has(reservation)) return deny('TEAM_TOOL_DUPLICATE');
      return { kind: 'allow', reservation };
    };
    return {
      async preExecute(exec, next) {
        if (exec.agent !== child) return next();
        const admitted = validate(exec, false);
        if (admitted.kind === 'deny') return admitted;
        record.scopeReservations.set(admitted.reservation, exec.callId);
        const decision = await next();
        if (decision.kind !== 'allow') return decision;
        const checked = validate(exec, true);
        return checked.kind === 'deny' ? checked : decision;
      },
      finalGuard(exec) {
        if (exec.agent !== child) return;
        // Native checkGuards runs after a possible approval await, before dispatch; it cannot grant permission.
        const checked = validate(exec, true);
        if (checked.kind === 'deny') return { reason: checked.reason, info: checked.info };
      },
    };
  }
  async function createChild(op, role, toolSet, signal) {
    const child = { role, end: deferred(), ended: false, calls: [], results: new Map(), messages: [],
      scopeReservations: new Map(), scopeDenials: [] };
    op.children[role] = child;
    const binding = config.roles[role];
    child.callId = `dsh-team-${randomUUID()}`;
    op.dispatchRole = role;
    try {
      const batch = await op.agent.ctx.tools.execute({ agent: op.agent, signal, toolSet,
        calls: [{ type: 'tool-call', id: child.callId, name: TOOL, arguments: json({ name: binding.memberName,
          description: `Owned ${role} ${config.runTag}`, cwd: config.workspace, provider: binding.route.provider,
          model: binding.route.model, reasoning_effort: 'low', agent_preset: binding.presetId,
          prompt: promptFor(role, config, op.tasks) }) }] });
      const failure = delegationFailure(batch, child, role, binding.memberName);
      if (failure) { op.delegationFailure = failure; fail('NATIVE_DELEGATION_FAILED'); }
      if (!child.id) fail('NATIVE_CHILD_NOT_OBSERVED');
    } finally { op.dispatchRole = undefined; }
  }
  async function perform(op, commandSignal) {
    const agent = op.agent;
    await assertTeamOwned(ctx, config, agent); commandSignal.throwIfAborted();
    if (agent.status !== 'idle' || pending(agent).length !== 0) fail('ROOT_NOT_IDLE');
    if (typeof agent.runMaintenance !== 'function' || typeof agent.whenIdle !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
    let result;
    try {
      result = await agent.runMaintenance(async maintenanceSignal => {
        const signal = AbortSignal.any([commandSignal, op.controller.signal, maintenanceSignal]);
        op.signal = signal;
        let mounted, toolSet;
        let terminalReason = 'SETTLED';
        const abort = () => {
          stopAdmission(op, signal.reason?.code ?? 'CANCELLED');
          for (const child of Object.values(op.children)) interrupt(op, child);
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          mounted = agent.ctx.plugin(nativeSubagent, { provider: 'spawn', toolName: TOOL,
            modelSelection: true, modelDiscovery: false, allowedAgentPresets: ROLES.map(r => config.roles[r].presetId),
            agentOptions: { reasoningEffort: 'low', maxTokens: 1024 }, maxDepth: 1 });
          await mounted;
          await preflightTeam(config, ctx.sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy'), ctx.llm, signal);
          await assertTeamOwned(ctx, config, agent);
          authorizeTeam(config, ctx.sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy'));
          signal.throwIfAborted();
          toolSet = await agent.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal });
          signal.throwIfAborted();
          if (!toolSet.view(agent).has(TOOL)) fail('SCOPED_NATIVE_TOOL_UNAVAILABLE');
          const beforeTeam = projection(agent, op); op.priorTeamMode = ctx.agentTeams.isEnabled(agent);
          // Disabled boards reject list/get; detach the durable pre-enable state before the native flush can await.
          op.baselineTasks = beforeTeam.tasks.filter(task => task.status !== 'deleted').map(taskState);
          if (spent) fail('RUN_ALREADY_ATTEMPTED');
          spent = true; op.mutationsStarted = true;
          try { await ctx.agentTeams.setEnabled(agent, true, signal); }
          catch (error) { op.persistenceUnconfirmed = true; reconcile(op, 'TEAM_MODE_PERSISTENCE_UNCONFIRMED'); throw error; }
          op.teamEnabled = true;
          unchangedBaseline(op); signal.throwIfAborted();
          try {
            op.tasks.implementer = await ctx.agentTeams.createTask(agent, { subject: `${config.runTag}: implement 2+3`,
              description: 'Claim this task, compute 2+3, edit this description to the requested result JSON, complete it, then notify the reviewer.', writeScopes: [] }, signal);
            op.confirmedTasks.implementer = taskState(op.tasks.implementer);
            unchangedBaseline(op); signal.throwIfAborted();
            op.tasks.reviewer = await ctx.agentTeams.createTask(agent, { subject: `${config.runTag}: review implementation`,
              description: 'Wait for the implementation message, inspect its completed task, claim this ready review task, verify 5, and complete the review.',
              blockedBy: [op.tasks.implementer.id], writeScopes: [] }, signal);
            op.confirmedTasks.reviewer = taskState(op.tasks.reviewer);
          } catch (error) {
            if (error?.code === 'TEAM_TASK_PERSISTENCE_UNCONFIRMED') op.persistenceUnconfirmed = true;
            if (/CONFLICT|CONCURRENT|REVISION|PERSISTENCE/.test(error?.code ?? '')) reconcile(op, error.code);
            throw error;
          }
          unchangedBaseline(op); signal.throwIfAborted();
          await createChild(op, 'reviewer', toolSet, signal);
          signal.throwIfAborted();
          if (op.failure) fail(op.failure);
          unchangedBaseline(op);
          await createChild(op, 'implementer', toolSet, signal);
          const ends = await Promise.all(ROLES.map(role => op.children[role].end.promise));
          signal.throwIfAborted(); if (op.failure) fail(op.failure);
          const roles = {};
          for (const [index, role] of ROLES.entries()) {
            const child = op.children[role], end = ends[index], task = ctx.agentTeams.getTask(agent, op.tasks[role].id);
            if (end.stopReason !== 'completed') fail('CHILD_NOT_COMPLETED');
            let output;
            try { output = JSON.parse(textOf(end.lastAssistantMessage)); } catch { fail('SYNTHETIC_OUTPUT_INVALID'); }
            if (output.role !== role || output.personaNonce !== config.roles[role].personaNonce || output.value !== 5
              || json(output.completedTaskIds) !== json([task.id])) fail('PRESET_PERSONA_NOT_PROVEN');
            if (task.status !== 'completed' || task.ownerId !== child.id) conflict(op, 'TEAM_TASK_COMPLETION_NOT_PROVEN');
            if (task.revision !== (role === 'implementer' ? 4 : 3)) conflict(op, 'TEAM_TASK_REVISION_CHANGED');
            if (json(task.blockedBy) !== json(role === 'reviewer' ? [op.tasks.implementer.id] : [])
              || task.writeScopes.length !== 0 || task.subject !== op.tasks[role].subject) conflict(op, 'TEAM_TASK_SCOPE_CHANGED');
            if (role === 'reviewer' && (output.reviewedTaskId !== op.tasks.implementer.id || output.verdict !== 'approved')) fail('TEAM_REVIEW_RESULT_INVALID');
            if (role === 'implementer') {
              let edited;
              try { edited = JSON.parse(task.description); } catch { conflict(op, 'TEAM_IMPLEMENTATION_RESULT_INVALID'); }
              if (edited.runTag !== config.runTag || edited.role !== role || edited.value !== 5) conflict(op, 'TEAM_IMPLEMENTATION_RESULT_INVALID');
            }
            validateWorkflow(config, op, role, task);
            const evidence = gate.evidence(role);
            if (evidence.admissions < 1 || evidence.admissions > config.roles[role].maxStreams || !evidence.usage
              || evidence.failure || evidence.denials.length !== 0 || !evidence.requiredToolsPresent) fail('MODEL_EVIDENCE_INCOMPLETE');
            roles[role] = { childSessionId: child.id, subagentRunId: child.runId, callId: child.callId,
              memberName: config.roles[role].memberName, presetId: config.roles[role].presetId, output, task,
              requestControls: config.roles[role].route, modelEvidence: evidence,
              toolCalls: child.calls.map(c => ({ ...c, succeeded: child.results.get(c.callId) })) };
          }
          const messages = op.children.reviewer.messages;
          if (messages.length !== 1 || messages[0].senderSessionId !== op.children.implementer.id) conflict(op, 'TEAM_PEER_MESSAGE_NOT_PROVEN');
          let handoff;
          try { handoff = JSON.parse(messages[0].content.filter(b => b.type === 'text').at(-1)?.text); }
          catch { fail('TEAM_PEER_MESSAGE_INVALID'); }
          if (handoff.runTag !== config.runTag || handoff.value !== 5 || handoff.implementationTaskId !== op.tasks.implementer.id) fail('TEAM_PEER_MESSAGE_INVALID');
          op.validatedBoard = unchangedBaseline(op);
          return { phase: 'two-native-model-team', ownedSessionId: config.ownedSessionId, runTag: config.runTag,
            roles, peerMessage: messages[0], childSessionsAndTasksRetained: true, driverAutomaticRetry: false,
            backendRequestCount: 'UNVERIFIED', serverIdentity: 'UNVERIFIED', accountDebit: 'UNVERIFIED' };
        } catch (error) {
          terminalReason = error?.code ?? 'HOST_OPERATION_FAILED'; stopAdmission(op, terminalReason); throw error;
        } finally {
          stopAdmission(op, terminalReason);
          signal.removeEventListener('abort', abort);
          for (const child of Object.values(op.children)) interrupt(op, child);
          await Promise.all(Object.values(op.children).filter(c => c.id && !c.ended).map(c => c.end.promise));
          try { op.cancelledParentNoticeIds = consumeNotices(op); }
          finally {
            for (const child of Object.values(op.children)) child.unobserve?.();
            toolSet?.dispose();
            if (mounted) { await mounted.dispose(); while (mounted.inertia) await mounted.inertia; }
            op.scopedDelegationToolDisposed = true;
            // A conflict ends our authority to write Team mode, including a nominal restoration write.
            if (op.teamEnabled && !op.persistenceUnconfirmed && !op.taskWriteFailureRequiresReconciliation && !op.reconciliationRequired) {
              const currentBoard = restorationAuthority(op);
              if (op.validatedBoard && json(currentBoard) !== json(op.validatedBoard)) conflict(op, 'TEAM_BOARD_CONCURRENT_CHANGE');
              try { await ctx.agentTeams.setEnabled(agent, op.priorTeamMode); }
              catch (error) { op.persistenceUnconfirmed = true; reconcile(op, 'TEAM_MODE_PERSISTENCE_UNCONFIRMED'); throw error; }
              op.teamModeRestored = ctx.agentTeams.isEnabled(agent) === op.priorTeamMode;
              if (!op.teamModeRestored) conflict(op, 'TEAM_MODE_RESTORATION_FAILED');
            }
          }
        }
      });
    } finally { await agent.whenIdle(); }
    if (gate.evidence().denials.length !== 0) fail('UNEXPECTED_OWNED_REQUEST');
    return { ...result, cancelledParentNoticeIds: op.cancelledParentNoticeIds,
      rootQuiescent: agent.status === 'idle', scopedDelegationToolDisposed: op.scopedDelegationToolDisposed,
      priorTeamMode: op.priorTeamMode, teamModeRestored: op.teamModeRestored,
      admissionClosed: gate.evidence().closed, admissionCloseReason: gate.evidence().closeReason };
  }
  async function handler({ agent, rawInput, signal, attachments }) {
    let op, timer, listener;
    try {
      if (closing) fail('UNLOADING');
      if (rawInput?.trim() !== 'run-pair' || !Array.isArray(attachments) || attachments.length !== 0) fail('USAGE_RUN_PAIR_ONLY');
      await assertTeamOwned(ctx, config, agent);
      if (closing) fail('UNLOADING'); signal.throwIfAborted();
      if (active) fail('BUSY'); if (spent) fail('RUN_ALREADY_ATTEMPTED');
      op = { agent, controller: new AbortController(), children: {}, tasks: {}, confirmedTasks: {} }; active = op;
      const combined = AbortSignal.any([signal, op.controller.signal]);
      const interrupted = new Promise((_, reject) => {
        listener = () => {
          stopAdmission(op, op.controller.signal.reason?.code ?? 'CANCELLED');
          reject(new LiveError(`${op.controller.signal.reason?.code ?? 'CANCELLED'}_DRAINING_GUARD_RETAINED`));
        };
        combined.addEventListener('abort', listener, { once: true });
      });
      timer = setTimeout(() => op.controller.abort(new LiveError('TIMEOUT')), config.timeoutMs);
      op.done = gate.run(() => perform(op, combined)).catch(error => {
        stopAdmission(op, error?.code ?? 'HOST_OPERATION_FAILED'); throw error;
      }).finally(() => {
        clearTimeout(timer); combined.removeEventListener('abort', listener); if (active === op) active = undefined;
      });
      return { kind: 'success', text: json(await Promise.race([op.done, interrupted])) };
    } catch (error) {
      let remainingTeamMode = null, observedTaskIds = [], reconciliationObservationFailed = false;
      if (op?.mutationsStarted) {
        try { remainingTeamMode = ctx.agentTeams.isEnabled(op.agent); observedTaskIds = ctx.agentTeams.listTasks(op.agent).map(task => task.id); }
        catch { reconciliationObservationFailed = true; }
      }
      return { kind: 'error', text: json({ code: error instanceof LiveError ? error.code : error?.code ?? 'HOST_OPERATION_FAILED',
        runTag: config.runTag, children: Object.fromEntries(Object.entries(op?.children ?? {}).map(([role, child]) =>
          [role, { childSessionId: child.id ?? null, subagentRunId: child.runId ?? null, callId: child.callId,
            ended: child.ended, scopeDenials: child.scopeDenials }])),
        taskIds: Object.fromEntries(Object.entries(op?.tasks ?? {}).map(([role, task]) => [role, task.id])),
        modelEvidence: gate.evidence(), interruptFailed: op?.interruptFailed === true, operationFailure: op?.failure ?? null,
        delegationFailure: op?.delegationFailure ?? null,
        teamModeRestored: op?.teamModeRestored ?? false, persistenceUnconfirmed: op?.persistenceUnconfirmed === true,
        taskWriteFailureRequiresReconciliation: op?.taskWriteFailureRequiresReconciliation === true,
        reconciliationRequired: op?.reconciliationRequired === true, reconciliationReasons: op?.reconciliationReasons ?? [],
        remainingTeamMode, observedTaskIds, reconciliationObservationFailed,
        stopFurtherMutation: true, noAutomaticRetry: true }) };
    }
  }
  ctx.effect(function* () {
    for (const dispose of unregister) yield dispose;
    yield ctx.on('llm/stream', gate.hook);
    yield ctx.on('subagent/start', info => {
      if (info.parentSessionId !== config.ownedSessionId) return;
      const op = active, role = op?.dispatchRole, record = op?.children[role];
      if (!op || !role || !record || !gate.inRun() || record.id || info.provider !== 'spawn' || info.local !== true) {
        gate.blockChild(info.id); if (op) { op.failure ??= 'UNEXPECTED_CHILD'; reconcile(op, 'UNEXPECTED_CHILD'); stopAdmission(op, op.failure); } return;
      }
      record.id = info.id; record.runId = info.runId;
      if (gate.evidence().closed || closing || op.controller.signal.aborted || op.signal?.aborted) {
        gate.blockChild(info.id); stopAdmission(op, 'CANCELLED'); interrupt(op, record); return;
      }
      gate.track(role, info.id);
      const child = ctx.agents.get(info.id), binding = config.roles[role];
      if (!child || child.session.header.parentSession !== config.ownedSessionId
        || ctx.agentPresets.composedPreset(child.ctx) !== binding.presetId
        || child.model.current()?.provider !== binding.route.provider || child.model.current()?.model !== binding.route.model
        || child.model.current()?.reasoningEffort !== 'low' || child.options.maxTokens !== 1024
        || typeof child.ctx.on !== 'function' || typeof child.ctx.tools?.guard !== 'function') {
        op.failure ??= 'CHILD_CONFIGURATION_CHANGED'; gate.blockChild(info.id); stopAdmission(op, op.failure); interrupt(op, record);
      } else record.unobserve = recordChildEvents(child, record, op, (call, succeeded) => {
        if (succeeded) { confirmTaskUpdate(op, record, call); return; }
        op.failure ??= 'TEAM_TOOL_FAILED';
        stopAdmission(op, op.failure);
        // A failed native write may have appended before persistence failed. Do not issue a restoration write blindly.
        if (call?.name === 'team_task_update' && !record.scopeDenials.some(d => d.callId === call.callId)) {
          op.taskWriteFailureRequiresReconciliation = true; reconcile(op, 'TEAM_TASK_WRITE_FAILED');
        }
        for (const other of Object.values(op.children)) interrupt(op, other);
      }, toolGuardFor(op, record, child));
      if (op.controller.signal.aborted) interrupt(op, record);
    });
    yield ctx.on('subagent/end', info => {
      const op = active;
      if (!op || info.parentSessionId !== config.ownedSessionId) return;
      const child = Object.values(op.children).find(c => c.id === info.id && c.runId === info.runId);
      if (child) {
        child.ended = true; child.end.resolve(info);
        if (info.stopReason !== 'completed') {
          op.failure ??= 'CHILD_NOT_COMPLETED'; stopAdmission(op, op.failure);
          for (const other of Object.values(op.children)) interrupt(op, other);
        }
      }
    });
    yield async () => {
      closing = true; const op = active; stopAdmission(op, 'UNLOADING');
      if (op) { op.controller.abort(new LiveError('UNLOADING'));
        for (const child of Object.values(op.children)) interrupt(op, child);
        await op.done.catch(() => {});
      }
    };
    const unregisterCommand = ctx.commands.register({ name: 'dsh-team-live', description: 'Two owned native roles; root model is quarantined',
      input: { hint: 'run-pair', attachments: false }, handler });
    yield () => {
      // This is the first reverse-order disposal step; stop model admission before command teardown can await.
      closing = true; stopAdmission(active, 'UNLOADING'); return unregisterCommand();
    };
  });
}
