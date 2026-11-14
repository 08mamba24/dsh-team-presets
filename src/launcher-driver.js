import { LiveError, fail } from './config.js';
import { parseLauncherConfig, readLauncherTemplate, assertLauncherOwned } from './launcher-config.js';
import { launcherTemplateFingerprint } from './launcher-template.js';
import { planLauncherMembers } from './launcher-plan.js';
import { observeLauncherMembers, registerLauncherPresets, makeLauncherSpawnCall, parseLauncherSpawnBatch } from './launcher-native.js';
import { authorizeTeam, preflightTeam } from './team-config.js';
import { createTeamGate } from './team-gate.js';
import { snapshotLauncherBoard, sameLauncherBoard, launcherBoardWithMode,
  launcherBoardAfterCreate, launcherBoardAfterUpdate } from './launcher-board.js';

const ROLES = ['implementer', 'reviewer'];
const SPAWN = 'dsh_team_launcher_spawn';
const json = value => JSON.stringify(value);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const queued = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn];
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const taskState = task => ({ id: task.id, revision: task.revision, ownerId: task.ownerId ?? null,
  status: task.status, subject: task.subject, description: task.description,
  blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] });
const stateList = tasks => tasks.map(taskState).sort((a, b) => String(a.id).localeCompare(String(b.id)));
const errorCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
  ? error.code : 'HOST_OPERATION_FAILED';

function bindings(config, template) {
  return { ownedSessionId: config.ownedSessionId, roles: Object.fromEntries(template.members.map(member => [member.name,
    { route: { provider: member.provider, model: member.model, reasoningEffort: member.reasoningEffort, maxTokens: 1024 },
      maxStreams: config.startup.maxStreams[member.name] }])) };
}
function startupPrompt(member, op, template) {
  const tasks = template.seedTasks.map(seed => ({ key: seed.key, id: op.tasks.get(seed.key).id,
    owner: seed.owner ?? null, blockedBy: seed.blockedBy.map(key => op.tasks.get(key).id) }));
  const context = '\n\nNative team startup context: ' + json({ role: member.name, tasks })
    + '\nThese are native task contexts for this role and later continuations; follow the template startup instruction above. '
    + 'Task owner names are assignment instructions. If you act on a task, use native current revisions and respect prerequisites. '
    + 'Read only the listed task ids. Only claim, edit description, or complete tasks assigned to your role or unassigned tasks. '
    + 'Messages may go only to the other already-created template member; never the Lead. '
    + 'Stop on any tool, delivery, persistence or CAS failure; do not retry or delegate.';
  return member.prompt + context;
}

/** Startup operations use native catalog/tasks only. Snapshots below grant cleanup authority, not member identity. */
export async function applyLauncher(ctx, rawConfig, nativeSubagent, controlEntry) {
  const config = parseLauncherConfig(rawConfig);
  if (!config) {
    ctx.commands.register({ name: 'dsh-team-launcher', description: 'Unconfigured native team launcher',
      input: { hint: 'plan | launch | restore', attachments: false },
      handler: async () => ({ kind: 'error', text: 'NOT_CONFIGURED' }) });
    return;
  }
  if (typeof nativeSubagent?.apply !== 'function' || typeof ctx.on !== 'function' || typeof ctx.effect !== 'function'
    || typeof ctx.sessionProjections?.stateOf !== 'function' || typeof ctx.agentPresets?.composedPreset !== 'function'
    || typeof ctx.subagents?.interrupt !== 'function'
    || ['isEnabled', 'setEnabled', 'createTask', 'getTask', 'listTasks'].some(key => typeof ctx.agentTeams?.[key] !== 'function')) {
    fail('HOST_CONTRACT_UNAVAILABLE');
  }
  let closing = false, active, restoreAuthority, template, fingerprint;
  let presetDisposers = [];
  const setup = deferred();
  const stop = (op, reason) => {
    if (!op) return;
    op.gate?.close(reason); op.admissionClosed ??= reason;
  };
  const reconcile = (op, reason) => {
    op.reconciliationRequired = true;
    if (!op.reconciliationReasons.includes(reason)) op.reconciliationReasons.push(reason);
  };
  const conflict = (op, reason) => { reconcile(op, reason); fail(reason); };
  const interrupt = (op, child) => {
    if (!child.id || (settledChildMatches(child) && [...child.additionalRuns.values()].every(run => run.ended
      && run.agent?.status === 'idle'))) return;
    try { ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: op.agent }); }
    catch { op.interruptFailed = true; op.failure ??= 'CHILD_INTERRUPT_FAILED'; stop(op, op.failure); }
  };
  const terminate = (op, reason) => {
    op.failure ??= reason; stop(op, reason);
    for (const child of Object.values(op.children)) interrupt(op, child);
  };
  const assertCurrent = (op, signal) => {
    if (closing) fail('UNLOADING');
    signal.throwIfAborted();
    if (active !== op) fail('OPERATION_NOT_CURRENT');
    if (op.failure) fail(op.failure);
    if (ctx.agents.get(config.ownedSessionId) !== op.agent || op.agent.id !== config.ownedSessionId
      || op.agent.session?.id !== config.ownedSessionId || op.agent.session.header?.origin === 'subagent') fail('WRONG_AGENT');
    if (op.agent.session.header?.cwd !== config.workspace) fail('WRONG_WORKSPACE');
  };
  function liveChildMatches(op, record, status) {
    try {
      const live = ctx.agents.get(record.id), member = op.members[record.role], route = op.controls.roles[record.role].route;
      return !!live && live === record.agent && live.status === status
        && live.id === record.id && live.session?.id === record.id && live.session.header?.origin === 'subagent'
        && live.session.header.parentSession === config.ownedSessionId && live.session.header.cwd === config.workspace
        && ctx.agentPresets.composedPreset(live.ctx) === member.agentPreset
        && live.model.current()?.provider === route.provider && live.model.current()?.model === route.model
        && live.model.current()?.reasoningEffort === route.reasoningEffort && live.options?.maxTokens === 1024;
    } catch { return false; }
  }
  function settledChildMatches(record, rootId = config.ownedSessionId) {
    const original = record.agent, live = ctx.agents.get(record.id);
    return record.ended === true && original?.status === 'idle' && original.id === record.id
      && original.session?.id === record.id && original.session.header?.origin === 'subagent'
      && original.session.header.parentSession === rootId && original.session.header.cwd === config.workspace
      // Native natural settlement unregisters its Agent before publishing the exact end event.
      && (live === undefined || live === original && live.status === 'idle');
  }
  function childrenQuietNow(op) {
    return !op.dispatchRole && Object.values(op.children).filter(child => child.id).every(child =>
      settledChildMatches(child) && [...child.additionalRuns.values()].every(run => run.ended && run.agent?.status === 'idle'));
  }
  async function drainChildren(op) {
    while (true) {
      const version = op.lifecycleVersion, records = Object.values(op.children).filter(child => child.id);
      await Promise.all(records.flatMap(child => [child.end.promise,
        ...[...child.additionalRuns.values()].map(run => run.end.promise)]));
      const handles = new Set(records.flatMap(child => [child.agent, ...[...child.additionalRuns.values()].map(run => run.agent)]));
      for (const handle of handles) {
        if (typeof handle?.whenIdle !== 'function') {
          reconcile(op, 'CHILD_DRAIN_UNCONFIRMED'); stop(op, 'CHILD_DRAIN_UNCONFIRMED');
          op.controller.abort(new LiveError('CHILD_DRAIN_UNCONFIRMED')); await new Promise(() => {});
        }
        await handle.whenIdle();
      }
      if (version !== op.lifecycleVersion) continue;
      if ([...handles].some(handle => handle.status !== 'idle')) continue;
      if (records.some(child => !settledChildMatches(child))) {
        reconcile(op, 'CHILD_DRAIN_UNCONFIRMED'); stop(op, 'CHILD_DRAIN_UNCONFIRMED');
        op.controller.abort(new LiveError('CHILD_DRAIN_UNCONFIRMED'));
        for (const child of records) interrupt(op, child);
        await new Promise(() => {});
      }
      return version;
    }
  }
  async function unload() {
    closing = true;
    const op = active;
    if (op) {
      stop(op, 'UNLOADING'); op.controller.abort(new LiveError('UNLOADING'));
      for (const child of Object.values(op.children)) interrupt(op, child);
    }
    await setup.promise;
    if (op?.done) await op.done.catch(() => {});
    for (const dispose of [...presetDisposers].reverse()) await dispose();
    presetDisposers = [];
  }
  ctx.effect(function* () { yield unload; });
  try {
    template = await readLauncherTemplate(config);
    if (closing) fail('UNLOADING');
    fingerprint = launcherTemplateFingerprint(template);
    presetDisposers = await registerLauncherPresets(ctx, config, template, controlEntry);
    if (closing) fail('UNLOADING');
  } finally { setup.resolve(); }

  function projection(op) {
    const state = ctx.sessionProjections.stateOf(op.agent.session, 'agentTeam');
    if (!state || !Array.isArray(state.tasks)) conflict(op, 'TEAM_PROJECTION_UNAVAILABLE');
    if (state.failure) conflict(op, 'TEAM_PROJECTION_FAILED');
    return state;
  }
  function board(op) {
    if (ctx.agents.get(config.ownedSessionId) !== op.agent || op.agent.session?.id !== config.ownedSessionId) conflict(op, 'WRONG_AGENT');
    if (op.expectedBoard && ctx.agentTeams.isEnabled(op.agent) !== (op.expectedBoard.enabled === true)) {
      conflict(op, 'TEAM_MODE_CONCURRENT_CHANGE');
    }
    let matches = false;
    try { matches = !!op.expectedBoard && sameLauncherBoard(projection(op), op.expectedBoard); }
    catch (error) { reconcile(op, errorCode(error)); throw error; }
    if (!matches) conflict(op, 'TEAM_BOARD_CONCURRENT_CHANGE');
    return stateList(ctx.agentTeams.listTasks(op.agent));
  }
  function confirmUpdate(op, record, call) {
    if (call.name !== 'team_task_update') return;
    try {
      const args = call.args, previous = op.confirmed.get(args.task_id);
      if (!previous || record.reservations.get(call.callId) !== json({ name: call.name, args })
        || op.writeReservations.get(args.task_id) !== call.callId || args.expected_revision !== previous.revision) throw new Error();
      const view = ctx.agentTeams.getTask(op.agent, args.task_id);
      const request = { taskId: args.task_id, expectedRevision: args.expected_revision, action: args.action,
        ...(args.action === 'edit' ? { description: args.description } : {}) };
      op.expectedBoard = launcherBoardAfterUpdate(op.expectedBoard, request,
        { id: record.id, name: ctx.subagents.namesOf(record.agent).self }, view);
      if (!sameLauncherBoard(projection(op), op.expectedBoard)) throw new Error();
      op.confirmed.set(args.task_id, taskState(view)); op.writeReservations.delete(args.task_id);
    } catch { reconcile(op, 'TEAM_TASK_STATE_UNCONFIRMED'); terminate(op, 'TEAM_TASK_STATE_UNCONFIRMED'); }
  }
  function guardFor(op, record, child) {
    const validate = (exec, reserved) => {
      const deny = reason => {
        record.scopeDenials.push({ callId: exec.callId, name: exec.name, reason });
        terminate(op, 'TEAM_TOOL_SCOPE_DENIED');
        return { kind: 'deny', reason, info: { name: 'DshLauncherScopeError', code: 'TEAM_TOOL_SCOPE_DENIED' } };
      };
      if (exec.signal.aborted || op.signal.aborted || closing || active !== op || record.ended
        || op.failure || op.gate.evidence().closed || ctx.agents.get(record.id) !== child) return deny('TEAM_RUN_NOT_ADMITTING');
      if (!op.members[record.role].nativeToolAllowlist.includes(exec.name)) return deny('TEAM_TOOL_OUT_OF_SCOPE');
      try { board(op); } catch (error) { return deny(errorCode(error)); }
      const args = exec.arguments;
      if (exec.name === 'team_task_get') {
        if (!exact(args, ['task_id']) || !op.confirmed.has(args.task_id)) return deny('TEAM_TASK_READ_OUT_OF_SCOPE');
      } else if (exec.name === 'team_task_update') {
        const keys = args?.action === 'edit' ? ['task_id', 'expected_revision', 'action', 'description'] : ['task_id', 'expected_revision', 'action'];
        if (!exact(args, keys) || !['claim', 'edit', 'complete'].includes(args.action)
          || !Number.isSafeInteger(args.expected_revision)) return deny('TEAM_TASK_WRITE_OUT_OF_SCOPE');
        const seed = op.taskSpecs.get(args.task_id), previous = op.confirmed.get(args.task_id);
        if (!seed || !previous || (seed.owner !== undefined && seed.owner !== record.role)
          || previous.revision !== args.expected_revision) return deny('TEAM_TASK_WRITE_OUT_OF_SCOPE');
        let actual;
        try { actual = ctx.agentTeams.getTask(child, args.task_id); } catch { return deny('TEAM_TASK_STATE_UNAVAILABLE'); }
        if (args.action === 'claim' ? actual.status !== 'pending' || actual.ownerId != null || actual.ready !== true
          : actual.status !== 'in_progress' || actual.ownerId !== record.id) return deny('TEAM_TASK_OWNERSHIP_OR_PREREQUISITE');
        if (args.action === 'edit' && (typeof args.description !== 'string' || args.description.length > 8000)) return deny('TEAM_TASK_EDIT_OUT_OF_SCOPE');
        const reservation = op.writeReservations.get(args.task_id);
        if (reserved ? reservation !== exec.callId : reservation !== undefined) return deny('TEAM_TASK_WRITE_PENDING');
      } else if (exec.name === 'send_message') {
        const peer = ROLES.find(role => role !== record.role), target = op.children[peer];
        if (!exact(args, ['agent', 'message']) || args.agent !== peer || !target?.id
          || typeof args.message !== 'string' || !args.message.trim() || args.message.length > 8000) return deny('TEAM_MESSAGE_OUT_OF_SCOPE');
        if (target.ended || target.additionalRuns.size || !liveChildMatches(op, target, 'running')) {
          return deny('TEAM_PEER_NOT_RUNNING');
        }
      } else if (exec.name === 'wait_agent') {
        if (!exact(args, ['timeout_ms']) || !Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 30000) return deny('TEAM_WAIT_OUT_OF_SCOPE');
      } else return deny('TEAM_TOOL_OUT_OF_SCOPE');
      const identity = json({ name: exec.name, args });
      if (typeof exec.callId !== 'string' || !exec.callId
        || (reserved ? record.reservations.get(exec.callId) !== identity : record.reservations.has(exec.callId))) return deny('TEAM_TOOL_CALL_CHANGED');
      return { kind: 'allow', identity };
    };
    return {
      async preExecute(exec, next) {
        if (exec.agent !== child) return next();
        const admitted = validate(exec, false);
        if (admitted.kind === 'deny') return admitted;
        record.reservations.set(exec.callId, admitted.identity);
        if (exec.name === 'team_task_update') op.writeReservations.set(exec.arguments.task_id, exec.callId);
        const decision = await next();
        if (decision.kind === 'deny') return decision;
        const rechecked = validate(exec, true);
        // Preserve native ask as ask; the final native guard checks again after approval.
        return rechecked.kind === 'deny' ? rechecked : decision;
      },
      finalGuard(exec) {
        if (exec.agent !== child) return;
        const decision = validate(exec, true);
        if (decision.kind === 'deny') return { reason: decision.reason, info: decision.info };
      },
    };
  }
  function watchChild(op, record, child) {
    const guard = guardFor(op, record, child), disposers = [];
    record.turnStarted = child.status === 'running'; record.turnIdle = false;
    disposers.push(child.ctx.on('agent/status', payload => {
      if (payload.agent !== child) return;
      if (payload.status === 'running') {
        if (record.turnIdle) {
          record.additionalDriverPhases++; op.lifecycleVersion++;
          reconcile(op, 'UNEXPECTED_CHILD_TURN'); terminate(op, 'UNEXPECTED_CHILD_TURN');
        }
        record.turnStarted = true;
      } else if (payload.status === 'idle' && record.turnStarted) record.turnIdle = true;
    }));
    disposers.push(child.ctx.on('tools/pre-execute', guard.preExecute));
    disposers.push(child.ctx.tools.guard(guard.finalGuard));
    disposers.push(child.ctx.on('session/event', (session, event) => {
      if (session.id !== record.id) return;
      if (event.type === 'turn/start') {
        const turn = event.data?.turn;
        if (!Number.isSafeInteger(turn) || turn < 1) {
          reconcile(op, 'CHILD_TURN_INVALID'); terminate(op, 'CHILD_TURN_INVALID'); return;
        }
        record.turnStarts.push(turn);
        if (record.turnStarts.length > 1) {
          record.additionalTurns++; op.lifecycleVersion++;
          reconcile(op, 'UNEXPECTED_CHILD_TURN'); terminate(op, 'UNEXPECTED_CHILD_TURN');
        }
      } else if (event.type === 'tool/call') {
        const data = event.data; let args;
        try { args = JSON.parse(data.arguments); } catch { terminate(op, 'TEAM_TOOL_ARGUMENTS_INVALID'); return; }
        record.calls.push({ callId: data.callId, name: data.name, args });
      } else if (event.type === 'tool/result') {
        const message = event.data.message, call = record.calls.find(item => item.callId === message.toolCallId);
        const success = message.isError === undefined || message.isError === false;
        if (!call || record.results.has(message.toolCallId)) { terminate(op, 'TEAM_TOOL_RESULT_UNATTRIBUTED'); return; }
        record.results.set(message.toolCallId, success);
        if (success) confirmUpdate(op, record, call);
        else {
          if (call.name === 'team_task_update') { op.persistenceUnconfirmed = true; reconcile(op, 'TEAM_TASK_WRITE_FAILED'); }
          terminate(op, 'TEAM_TOOL_FAILED');
        }
      }
    }));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  }
  function installStartup(op) {
    // Yielding each native disposer transfers it out of Cordis's parallel top-level effects.
    // The group's reverse-order teardown must join actual drain before removing any listener.
    const removed = deferred();
    let removeStream, removeStart, removeEnd;
    const group = ctx.effect(function* () {
      // Reverse teardown reaches this only after all three native hook disposers have settled.
      yield () => { removed.resolve(); };
      yield (removeStream = ctx.on('llm/stream', op.gate.hook));
      yield (removeStart = ctx.on('subagent/start', info => {
      if (info.parentSessionId !== config.ownedSessionId) return;
      if (info.provider !== 'spawn' || info.local !== true || typeof info.runId !== 'string' || !info.runId) {
        op.gate.blockChild(info.id); reconcile(op, 'CHILD_LIFECYCLE_INVALID'); terminate(op, 'CHILD_LIFECYCLE_INVALID'); return;
      }
      const previous = Object.values(op.children).find(child => child.id === info.id);
      if (previous) {
        if (info.runId !== previous.runId && !previous.additionalRuns.has(info.runId)) {
          previous.additionalRuns.set(info.runId, { id: info.id, runId: info.runId, agent: ctx.agents.get(info.id),
            ended: false, end: deferred() });
          op.lifecycleVersion++;
        }
        op.gate.blockChild(info.id); reconcile(op, 'UNEXPECTED_CHILD_RUN'); terminate(op, 'UNEXPECTED_CHILD_RUN');
        return;
      }
      const role = op.dispatchRole, record = op.children[role];
      if (!role || !record || record.id || info.provider !== 'spawn' || info.local !== true || !op.gate.inRun()) {
        op.gate.blockChild(info.id); reconcile(op, 'UNEXPECTED_CHILD'); terminate(op, 'UNEXPECTED_CHILD'); return;
      }
      // Even a late publication belongs to this dispatch and must enter the drain set before cancellation.
      record.id = info.id; record.runId = info.runId;
      op.lifecycleVersion++;
      record.agent = ctx.agents.get(info.id);
      if (closing || op.signal?.aborted || op.controller.signal.aborted || op.gate.evidence().closed) {
        op.gate.blockChild(info.id); interrupt(op, record); return;
      }
      const child = record.agent, member = op.members[role], route = op.controls.roles[role].route;
      try {
        op.gate.track(role, info.id);
        if (!child || child.id !== info.id || child.session?.id !== info.id
          || child.session.header?.origin !== 'subagent' || child.session.header.parentSession !== config.ownedSessionId
          || child.session.header.cwd !== config.workspace
          || ctx.agentPresets.composedPreset(child.ctx) !== member.agentPreset
          || child.model.current()?.provider !== route.provider || child.model.current()?.model !== route.model
          || child.model.current()?.reasoningEffort !== route.reasoningEffort || child.options?.maxTokens !== 1024
          || typeof child.whenIdle !== 'function' || typeof child.ctx?.on !== 'function'
          || typeof child.ctx.tools?.guard !== 'function') fail('CHILD_CONFIGURATION_CHANGED');
        record.unobserve = watchChild(op, record, child);
      } catch (error) { op.gate.blockChild(info.id); terminate(op, errorCode(error)); }
      }));
      yield (removeEnd = ctx.on('subagent/end', info => {
      if (info.parentSessionId !== config.ownedSessionId) return;
      if (info.provider !== 'spawn' || info.local !== true) {
        reconcile(op, 'CHILD_LIFECYCLE_INVALID'); terminate(op, 'CHILD_LIFECYCLE_INVALID'); return;
      }
      const record = Object.values(op.children).find(child => child.id === info.id);
      const run = record?.runId === info.runId ? record : record?.additionalRuns.get(info.runId);
      if (!run || run.ended) return;
      run.ended = true; run.endInfo = info; run.end.resolve(info); op.lifecycleVersion++;
      if (info.stopReason !== 'completed') terminate(op, 'CHILD_NOT_COMPLETED');
      }));
      yield async () => {
        if (!op.startupDrained) {
          stop(op, 'UNLOADING');
          op.controller.abort(new LiveError('UNLOADING'));
          for (const child of Object.values(op.children)) interrupt(op, child);
        }
        // op.done includes normal removeStartup(), so waiting on it here would self-deadlock.
        await op.startupDrain.promise;
        while (true) {
          const version = await drainChildren(op);
          const ids = consumeNotices(op);
          op.cancelledParentNoticeIds = [...(op.cancelledParentNoticeIds ?? []), ...ids];
          await op.agent.whenIdle();
          // Recheck after the await, then perform the public synchronous unregisters in this same turn.
          if (version !== op.lifecycleVersion || !childrenQuietNow(op) || op.agent.status !== 'idle') continue;
          if (op.expectedBoard) {
            try {
              if (!sameLauncherBoard(projection(op), op.expectedBoard)) conflict(op, 'TEAM_BOARD_CONCURRENT_CHANGE');
            } catch (error) { reconcile(op, errorCode(error)); terminate(op, errorCode(error)); }
          }
          removeEnd(); removeStart(); removeStream();
          break;
        }
      };
    });
    return async () => {
      await group();
      // A second public effect-disposer call can return undefined while external teardown is in flight.
      await removed.promise;
    };
  }
  function consumeNotices(op) {
    const ids = [];
    for (const child of Object.values(op.children).filter(item => item.id)) {
      const notices = queued(op.agent).filter(message => message.source?.kind === 'subagent-settled'
        && message.source.senderSessionId === child.id);
      const expected = (child.ended ? 1 : 0) + [...child.additionalRuns.values()].filter(run => run.ended).length
        - (child.noticesConsumed ?? 0);
      if (notices.length !== expected) conflict(op, 'ROOT_SETTLEMENT_NOTICE_UNCONFIRMED');
      for (const notice of notices) {
        if (!op.agent.inbox.remove(notice.id)) conflict(op, 'NOTICE_CANCELLATION_FAILED');
        ids.push(notice.id);
      }
      child.noticesConsumed = (child.noticesConsumed ?? 0) + notices.length;
    }
    return ids;
  }
  async function createSeedTasks(op) {
    const remaining = [...template.seedTasks];
    while (remaining.length) {
      const index = remaining.findIndex(seed => seed.blockedBy.every(key => op.tasks.has(key)));
      if (index < 0) fail('SEED_TASK_DEPENDENCY_INVALID');
      const seed = remaining.splice(index, 1)[0];
      assertCurrent(op, op.signal); board(op);
      let created;
      const request = { subject: seed.subject, description: seed.description,
        blockedBy: seed.blockedBy.map(key => op.tasks.get(key).id), writeScopes: [] };
      try {
        created = await ctx.agentTeams.createTask(op.agent, request, op.signal);
      } catch (error) { op.persistenceUnconfirmed = true; reconcile(op, 'TEAM_TASK_CREATE_UNCONFIRMED'); throw error; }
      // Record successful native writes before checking cancellation.
      op.tasks.set(seed.key, created); op.confirmed.set(created.id, taskState(created)); op.taskSpecs.set(created.id, seed);
      try { op.expectedBoard = launcherBoardAfterCreate(op.expectedBoard, request, created); }
      catch { reconcile(op, 'TEAM_TASK_CREATE_UNCONFIRMED'); fail('TEAM_TASK_CREATE_UNCONFIRMED'); }
      assertCurrent(op, op.signal); board(op);
    }
  }
  async function createChild(op, role, toolSet) {
    const member = op.members[role], record = { role, end: deferred(), ended: false, calls: [], results: new Map(),
      reservations: new Map(), scopeDenials: [], additionalRuns: new Map(), additionalTurns: 0,
      additionalDriverPhases: 0, turnStarts: [] };
    op.children[role] = record;
    const call = makeLauncherSpawnCall(member, { workspace: config.workspace, prompt: startupPrompt(member, op, template) });
    record.callId = call.id; op.dispatchRole = role;
    try {
      const batch = await op.agent.ctx.tools.execute({ agent: op.agent, signal: op.signal, toolSet, calls: [call] });
      const result = parseLauncherSpawnBatch(batch, call, member);
      if (!result.ok) { op.delegationFailure = result.delegationFailure; fail(result.code); }
      assertCurrent(op, op.signal);
      if (!record.id || !record.runId) fail('NATIVE_CHILD_NOT_OBSERVED');
      if (op.failure) fail(op.failure);
    } finally { op.dispatchRole = undefined; }
  }
  function childReceipt(op) {
    return ROLES.filter(role => op.children[role]).map(name => {
      const child = op.children[name], member = op.members[name];
      return { name, id: child.id ?? null, runId: child.runId ?? null, callId: child.callId,
        agentPreset: member.agentPreset, route: op.controls.roles[name].route,
        tools: op.gate.evidence(name).toolNames ?? [], ended: child.ended, scopeDenials: child.scopeDenials,
        turnStarts: [...child.turnStarts], additionalTurns: child.additionalTurns,
        additionalDriverPhases: child.additionalDriverPhases, settlement: child.id && settledChildMatches(child) ?
          ctx.agents.get(child.id) === undefined ? 'disposed' : 'live-idle' : 'unconfirmed',
        additionalRuns: [...child.additionalRuns.values()].map(run => ({ id: run.id, runId: run.runId, ended: run.ended })) };
    });
  }
  async function launch(op, commandSignal) {
    const agent = op.agent;
    if (agent.status !== 'idle' || queued(agent).length) fail('ROOT_NOT_IDLE');
    if (typeof agent.runMaintenance !== 'function' || typeof agent.whenIdle !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
    op.gate = createTeamGate(op.controls, { roleTools: Object.fromEntries(template.members.map(member => [member.name, member.nativeToolAllowlist])) });
    op.startupDrain = deferred(); op.startupDrained = false;
    const removeStartup = installStartup(op);
    let result;
    try {
      await op.gate.run(() => agent.runMaintenance(async maintenanceSignal => {
        op.signal = AbortSignal.any([commandSignal, op.controller.signal, maintenanceSignal]);
        const abort = () => { stop(op, errorCode(op.controller.signal.reason) === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
          for (const child of Object.values(op.children)) interrupt(op, child); };
        op.signal.addEventListener('abort', abort, { once: true });
        let mounted, toolSet, successful = false;
        try {
          assertCurrent(op, op.signal);
          mounted = agent.ctx.plugin(nativeSubagent, { provider: 'spawn', toolName: SPAWN, modelSelection: true,
            modelDiscovery: false, allowedAgentPresets: template.members.map(member => member.agentPreset),
            agentOptions: { reasoningEffort: 'low', maxTokens: 1024 }, maxDepth: 1 });
          await mounted; assertCurrent(op, op.signal);
          await preflightTeam(op.controls, ctx.sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy'), ctx.llm, op.signal);
          assertCurrent(op, op.signal);
          await assertLauncherOwned(ctx, config, agent); assertCurrent(op, op.signal);
          authorizeTeam(op.controls, ctx.sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy'));
          toolSet = await agent.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal: op.signal });
          assertCurrent(op, op.signal);
          if (!toolSet.view(agent).has(SPAWN)) fail('SCOPED_NATIVE_TOOL_UNAVAILABLE');
          // The durable raw projection is readable even while native Team APIs are disabled.
          const before = projection(op); op.priorMode = ctx.agentTeams.isEnabled(agent);
          op.expectedBoard = snapshotLauncherBoard(before);
          // Bound startup text before the first mutation; real ids are bounded native identifiers.
          if (template.members.some(member => member.prompt.length + json(template.seedTasks).length + 2048 > 8000)) fail('LAUNCHER_STARTUP_CONTEXT_TOO_LARGE');
          op.mutationsStarted = true;
          try { await ctx.agentTeams.setEnabled(agent, true, op.signal); }
          catch (error) { op.persistenceUnconfirmed = true; reconcile(op, 'TEAM_MODE_PERSISTENCE_UNCONFIRMED'); throw error; }
          op.expectedBoard = launcherBoardWithMode(op.expectedBoard, true);
          op.teamEnabled = true;
          assertCurrent(op, op.signal); board(op);
          await createSeedTasks(op);
          await createChild(op, 'reviewer', toolSet); assertCurrent(op, op.signal);
          await createChild(op, 'implementer', toolSet);
          await Promise.all(Object.values(op.children).map(child => child.end.promise));
          await drainChildren(op);
          assertCurrent(op, op.signal);
          if (op.failure) fail(op.failure);
          op.endedBoard = board(op);
          for (const role of ROLES) {
            const evidence = op.gate.evidence(role), child = op.children[role];
            if (!child.ended || child.endInfo.stopReason !== 'completed' || child.calls.some(call => child.results.get(call.callId) !== true)
              || evidence.admissions < 1 || evidence.admissions > op.controls.roles[role].maxStreams || !evidence.usage
              || evidence.failure || evidence.denials.length || !evidence.requiredToolsPresent) fail('MODEL_EVIDENCE_INCOMPLETE');
          }
          successful = true;
        } catch (error) { terminate(op, errorCode(error)); throw error; }
        finally {
          stop(op, successful ? 'STARTUP_COMPLETED' : op.failure ?? 'STARTUP_FAILED');
          for (const child of Object.values(op.children)) interrupt(op, child);
          // Native dispatch is awaited above, so late start publications have already entered children.
          await drainChildren(op);
          try {
            op.cancelledParentNoticeIds = consumeNotices(op);
            if (op.teamEnabled && !op.persistenceUnconfirmed && !op.reconciliationRequired) {
              const endBoard = board(op);
              if (successful) op.endedBoard = endBoard;
              else {
                try { await ctx.agentTeams.setEnabled(agent, op.priorMode); }
                catch (error) { op.persistenceUnconfirmed = true; reconcile(op, 'TEAM_MODE_PERSISTENCE_UNCONFIRMED'); throw error; }
                op.expectedBoard = launcherBoardWithMode(op.expectedBoard, op.priorMode);
                if (!sameLauncherBoard(projection(op), op.expectedBoard)) conflict(op, 'TEAM_BOARD_CONCURRENT_CHANGE');
                op.teamModeRestored = ctx.agentTeams.isEnabled(agent) === op.priorMode;
                if (!op.teamModeRestored) conflict(op, 'TEAM_MODE_RESTORATION_FAILED');
              }
            }
          } finally {
            for (const child of Object.values(op.children)) child.unobserve?.();
            toolSet?.dispose();
            if (mounted) { await mounted.dispose(); while (mounted.inertia) await mounted.inertia; }
            op.scopedDelegationToolDisposed = true;
            op.signal.removeEventListener('abort', abort);
          }
        }
      }));
      await agent.whenIdle();
      op.rootDrained = true;
      if (op.failure) fail(op.failure);
      if (op.gate.evidence().denials.length) fail('UNEXPECTED_OWNED_REQUEST');
      if (agent.status !== 'idle') fail('ROOT_NOT_IDLE');
      restoreAuthority = { agent, priorMode: op.priorMode, board: structuredClone(op.endedBoard), rawBoard: snapshotLauncherBoard(op.expectedBoard),
        children: Object.values(op.children).map(child => ({ id: child.id, runId: child.runId, agent: child.agent, ended: child.ended })) };
      const createdIds = new Set([...op.tasks.values()].map(task => task.id));
      result = { ok: true, mode: 'launch', templateFingerprint: fingerprint, members: childReceipt(op),
        tasks: op.endedBoard.filter(task => createdIds.has(task.id)),
        gate: op.gate.evidence(), team: { priorMode: op.priorMode, currentMode: ctx.agentTeams.isEnabled(agent) },
        cancelledParentNoticeIds: op.cancelledParentNoticeIds, restorable: true,
        scopedDelegationToolDisposed: op.scopedDelegationToolDisposed };
    } finally {
      // This hook is startup-scoped. Presets deliberately outlive it for native continuations.
      // A failed maintenance scope also has to release the exact root execution before unguarding it.
      try {
        if (!op.rootDrained) await agent.whenIdle();
        await drainChildren(op);
        if (agent.status !== 'idle' || op.dispatchRole
          || Object.values(op.children).some(child => child.id && !child.ended)) fail('ROOT_DRAIN_UNCONFIRMED');
        op.startupDrained = true;
        op.startupDrain.resolve();
      }
      catch {
        reconcile(op, 'ROOT_DRAIN_UNCONFIRMED'); stop(op, 'ROOT_DRAIN_UNCONFIRMED');
        // No public force-drain exists. Keep op active and the guard installed for an explicit later handoff.
        await new Promise(() => {});
      }
      try { await removeStartup(); }
      catch {
        reconcile(op, 'STARTUP_GUARD_DISPOSAL_UNCONFIRMED'); stop(op, 'STARTUP_GUARD_DISPOSAL_UNCONFIRMED');
        await new Promise(() => {});
      }
    }
    try {
      assertCurrent(op, commandSignal);
      if (op.gate.evidence().denials.length) fail('UNEXPECTED_OWNED_REQUEST');
    }
    catch (error) { restoreAuthority = undefined; throw error; }
    return { ...result, members: childReceipt(op), gate: op.gate.evidence(),
      cancelledParentNoticeIds: op.cancelledParentNoticeIds };
  }
  async function restore(op, signal) {
    const authority = restoreAuthority, agent = op.agent;
    if (!authority || authority.agent !== agent) fail('RESTORE_AUTHORITY_UNAVAILABLE');
    if (typeof agent.runMaintenance !== 'function' || typeof agent.whenIdle !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
    const verify = () => {
      if (agent.status !== 'idle' || queued(agent).length) fail('RESTORE_ROOT_NOT_IDLE');
      for (const child of authority.children) {
        if (!settledChildMatches(child, agent.id)) fail('RESTORE_CHILD_NOT_IDLE');
      }
      const state = ctx.sessionProjections.stateOf(agent.session, 'agentTeam');
      if (!state || state.failure || !ctx.agentTeams.isEnabled(agent)
        || !sameLauncherBoard(state, authority.rawBoard)) conflict(op, 'RESTORE_BOARD_CONFLICT');
    };
    assertCurrent(op, signal); verify();
    try {
      try { await agent.runMaintenance(async maintenanceSignal => {
      const combined = AbortSignal.any([signal, op.controller.signal, maintenanceSignal]);
      assertCurrent(op, combined);
      // runMaintenance changes root status, but only the two exact child handles and board must stay idle/unchanged.
      for (const child of authority.children) {
        if (!settledChildMatches(child, agent.id)) fail('RESTORE_CHILD_NOT_IDLE');
      }
      const current = ctx.sessionProjections.stateOf(agent.session, 'agentTeam');
      if (!current || current.failure || !ctx.agentTeams.isEnabled(agent)
        || !sameLauncherBoard(current, authority.rawBoard) || queued(agent).length) conflict(op, 'RESTORE_BOARD_CONFLICT');
      op.restoreWriteAttempted = true;
      try { await ctx.agentTeams.setEnabled(agent, authority.priorMode, combined); }
      catch {
        restoreAuthority = undefined; op.persistenceUnconfirmed = true;
        reconcile(op, 'RESTORE_PERSISTENCE_UNCONFIRMED'); fail('RESTORE_PERSISTENCE_UNCONFIRMED');
      }
      assertCurrent(op, combined);
      if (ctx.agentTeams.isEnabled(agent) !== authority.priorMode) {
        op.persistenceUnconfirmed = true; fail('RESTORE_MODE_UNCONFIRMED');
      }
      const flushed = ctx.sessionProjections.stateOf(agent.session, 'agentTeam');
      if (!flushed || flushed.failure || !Array.isArray(flushed.tasks)
        || !sameLauncherBoard(flushed, launcherBoardWithMode(authority.rawBoard, authority.priorMode))) {
        restoreAuthority = undefined; reconcile(op, 'RESTORE_BOARD_CONFLICT'); fail('RESTORE_BOARD_CONFLICT');
      }
      for (const child of authority.children) {
        if (!settledChildMatches(child, agent.id)) {
          restoreAuthority = undefined; fail('RESTORE_CHILD_NOT_IDLE');
        }
      }
      }); } finally { await agent.whenIdle(); }
      assertCurrent(op, signal);
    } catch (error) {
      if (op.restoreWriteAttempted) {
        restoreAuthority = undefined;
        reconcile(op, errorCode(error));
      }
      throw error;
    }
    restoreAuthority = undefined;
    return { ok: true, mode: 'restore', teamModeRestored: true, priorMode: authority.priorMode,
      retainedTaskIds: authority.board.map(task => task.id), retainedChildIds: authority.children.map(child => child.id) };
  }
  async function handler({ agent, rawInput, signal, attachments }) {
    let op, timer, abortListener;
    try {
      if (closing) fail('UNLOADING');
      const command = rawInput?.trim();
      if (!['plan', 'launch', 'restore'].includes(command) || !Array.isArray(attachments) || attachments.length) fail('USAGE_PLAN_LAUNCH_RESTORE_ONLY');
      if (active) fail('BUSY');
      await assertLauncherOwned(ctx, config, agent);
      if (closing) fail('UNLOADING'); signal.throwIfAborted(); if (active) fail('BUSY');
      const fresh = await readLauncherTemplate(config);
      if (closing) fail('UNLOADING'); signal.throwIfAborted(); if (active) fail('BUSY');
      if (launcherTemplateFingerprint(fresh) !== fingerprint) fail('LAUNCHER_TEMPLATE_CHANGED');
      op = { agent, command, controller: new AbortController(), children: {}, tasks: new Map(), confirmed: new Map(),
        lifecycleVersion: 0,
        taskSpecs: new Map(), writeReservations: new Map(), reconciliationReasons: [],
        members: Object.fromEntries(fresh.members.map(member => [member.name, member])), controls: bindings(config, fresh) };
      active = op; // No await between the final checks and this claim.
      const combined = AbortSignal.any([signal, op.controller.signal]);
      const interrupted = new Promise((_, reject) => {
        abortListener = () => {
          const reason = op.controller.signal.reason?.code ?? 'CANCELLED'; stop(op, reason);
          for (const child of Object.values(op.children)) interrupt(op, child);
          reject(new LiveError(`${reason}_DRAINING_GUARD_RETAINED`));
        };
        combined.addEventListener('abort', abortListener, { once: true });
      });
      timer = setTimeout(() => { stop(op, 'TIMEOUT'); op.controller.abort(new LiveError('TIMEOUT')); }, config.timeoutMs);
      op.done = (async () => {
        if (command === 'restore') return restore(op, combined);
        const observation = await observeLauncherMembers(ctx, agent, combined);
        assertCurrent(op, combined);
        const plan = planLauncherMembers(fresh, observation);
        op.plan = plan; op.catalogReason = observation.reason;
        if (command === 'plan') return { ok: !plan.blocked, mode: 'plan', plan, templateFingerprint: fingerprint };
        if (plan.blocked || plan.members.some(member => member.action !== 'create')) fail('LAUNCHER_MEMBER_CONFLICT');
        return launch(op, combined);
      })().catch(error => { stop(op, errorCode(error)); throw error; }).finally(() => {
        clearTimeout(timer); combined.removeEventListener('abort', abortListener);
        if (active === op) active = undefined;
      });
      return { kind: 'success', text: json(await Promise.race([op.done, interrupted])) };
    } catch (error) {
      return { kind: 'error', text: json({ code: errorCode(error), mode: op?.command ?? null,
        members: op ? childReceipt(op) : [], gate: op?.gate?.evidence() ?? null,
        taskIds: op ? [...op.tasks.values()].map(task => task.id) : [],
        operationFailure: op?.failure ?? null, delegationFailure: op?.delegationFailure ?? null,
        plan: op?.plan ?? null, catalogReason: op?.catalogReason ?? null,
        persistenceUnconfirmed: op?.persistenceUnconfirmed === true, reconciliationRequired: op?.reconciliationRequired === true,
        reconciliationReasons: op?.reconciliationReasons ?? [], teamModeRestored: op?.teamModeRestored === true,
        interruptFailed: op?.interruptFailed === true, stopFurtherMutation: true, noAutomaticRetry: true }) };
    }
  }
  const unregister = ctx.commands.register({ name: 'dsh-team-launcher', description: 'Plan, launch or restore an owned native team',
    input: { hint: 'plan | launch | restore', attachments: false }, handler });
  ctx.effect(function* () {
    yield () => {
      closing = true; stop(active, 'UNLOADING');
      if (active) active.controller.abort(new LiveError('UNLOADING'));
      return unregister();
    };
  });
}
