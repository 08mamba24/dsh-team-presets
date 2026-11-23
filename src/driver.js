import { readAuthorizedRoutes } from './host-adapter.js';
import { randomUUID } from 'node:crypto';
import { parseConfig, preflight, authorize, LiveError, fail } from './config.js';
import { assertOwned, assertWorkingDirectory, childWorkingDirectoryMatches } from './owned.js';
import { createGate } from './gate.js';

const TOOL = 'dsh_live_one_spawn';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pending = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn];

/** Dependencies are the actual installed native tool module in production; fixtures inject a synthetic module. */
export async function applyLive(ctx, raw, nativeSubagent) {
  const config = parseConfig(raw);
  if (!config) {
    ctx.commands.register({ name: 'dsh-subagent-live', description: 'Unconfigured one-child driver',
      input: { hint: 'run-one', attachments: false }, handler: async () => ({ kind: 'error', text: 'NOT_CONFIGURED' }) });
    return;
  }
  if (typeof nativeSubagent?.apply !== 'function' || typeof ctx.sessionProjections?.stateOf !== 'function'
    || typeof ctx.agentPresets?.register !== 'function' || typeof ctx.subagents?.interrupt !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
  const gate = createGate(config);
  let active, spent = false, closing = false;
  const unregisterPreset = await ctx.agentPresets.register({ id: config.presetId,
    name: 'Owned one-child implementer', plugins: [{ id: `${config.presetId}-persona`,
      name: 'dsh-subagent-live-rc2-local/role', config: { ownedSessionId: config.ownedSessionId,
        runTag: config.runTag, personaNonce: config.personaNonce } }] });

  function interrupt(op) {
    if (!op.childId || op.ended) return;
    // The pinned native API returns void. A synchronous failure must never skip drain.
    try { ctx.subagents.interrupt(op.childId, { kind: 'ancestor', agent: op.agent }); }
    catch { op.interruptFailed = true;op.failure ??= 'CHILD_INTERRUPT_FAILED'; }
  }
  function consumeOwnNotice(op) {
    const queued = pending(op.agent);
    if (!op.childId) { if (queued.length !== 0) fail('ROOT_INBOX_CHANGED'); return []; }
    if (queued.length !== 1 || queued[0].source?.kind !== 'subagent-settled'
      || queued[0].source.senderSessionId !== op.childId) fail('ROOT_INBOX_CHANGED');
    const id = queued[0].id;
    // Native durable inbox cancellation, not Session deletion. Only our exact child's notice is removed.
    if (!op.agent.inbox.remove(id) || pending(op.agent).length !== 0) fail('NOTICE_CANCELLATION_FAILED');
    return [id];
  }
  const readPolicy = agent => readAuthorizedRoutes(ctx, agent.session);

  async function perform(op, commandSignal) {
    const agent = op.agent;
    await assertOwned(ctx, config, agent);
    commandSignal.throwIfAborted();
    if (agent.status !== 'idle' || pending(agent).length !== 0) fail('ROOT_NOT_IDLE');
    if (typeof agent.runMaintenance !== 'function' || typeof agent.whenIdle !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
    let receipt;
    try {
      receipt = await agent.runMaintenance(async maintenanceSignal => {
        const signal = AbortSignal.any([commandSignal, op.controller.signal, maintenanceSignal]);
        let mounted, toolSet;
        const abort = () => interrupt(op);
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          mounted = agent.ctx.plugin(nativeSubagent, { provider: 'spawn', toolName: TOOL,
            modelSelection: true, modelDiscovery: false, allowedAgentPresets: [config.presetId],
            agentOptions: { reasoningEffort: 'low', maxTokens: 1024 }, maxDepth: 1 });
          await mounted;
          const policy = readPolicy(agent);
          await preflight(config, policy, ctx.llm, signal);
          await assertOwned(ctx, config, agent);
          authorize(config, readPolicy(agent));
          signal.throwIfAborted();
          toolSet = await agent.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal });
          signal.throwIfAborted();
          if (!toolSet.view(agent).has(TOOL)) fail('SCOPED_NATIVE_TOOL_UNAVAILABLE');
          assertWorkingDirectory(ctx, config, agent);
          authorize(config, readPolicy(agent));
          if (spent) fail('RUN_ALREADY_ATTEMPTED');
          spent = true;
          op.dispatching = true;
          op.callId = `dsh-live-${randomUUID()}`;
          const batch = await agent.ctx.tools.execute({ agent, signal, toolSet, calls: [{ type: 'tool-call', id: op.callId,
            name: TOOL, arguments: JSON.stringify({ name: config.memberName, description: `Owned synthetic ${config.runTag}`,
              provider: config.route.provider, model: config.route.model,
              reasoning_effort: 'low', agent_preset: config.presetId,
              prompt: 'Compute 2+3. Return only a JSON object with role, personaNonce from your system persona, and value. Do not call tools or delegate.' }) }] });
          if (batch.results?.length !== 1 || batch.results[0].callId !== op.callId
            || batch.results[0].result?.isError !== false || batch.results[0].result.value?.kind !== 'activation'
            || batch.results[0].result.value.name !== config.memberName
            || batch.additionalContexts?.length !== 0 || batch.concluded !== false) fail('NATIVE_DELEGATION_FAILED');
          if (!op.childId) fail('NATIVE_CHILD_NOT_OBSERVED');
          const end = await op.end.promise;
          signal.throwIfAborted();
          if (op.failure) fail(op.failure);
          if (end.stopReason !== 'completed') fail('CHILD_NOT_COMPLETED');
          const text = (end.lastAssistantMessage ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
          let output;
          try { output = JSON.parse(text); } catch { fail('SYNTHETIC_OUTPUT_INVALID'); }
          if (output.role !== 'implementer' || output.personaNonce !== config.personaNonce || output.value !== 5) fail('PRESET_PERSONA_NOT_PROVEN');
          const audit = op.audits.get(op.childId), evidence = gate.evidence();
          if (!audit || audit.allowedResult !== 5 || audit.forbiddenResult !== 'rejected_by_native_executor'
            || audit.toolNames?.length !== 1 || audit.toolNames[0] !== 'dsh_live_echo') fail('ROLE_CAPABILITIES_NOT_PROVEN');
          if (evidence.admissions !== 1 || !evidence.usage || evidence.failure || evidence.denials.length !== 0) fail('MODEL_EVIDENCE_INCOMPLETE');
          return { phase: 'one-native-child', ownedSessionId: config.ownedSessionId, runTag: config.runTag,
            childSessionId: op.childId, subagentRunId: op.runId, memberName: config.memberName, callId: op.callId,
            presetId: config.presetId, roleAudit: audit, output, requestControls: config.route,
            recordedSessionRouteAuthorized: true, modelEvidence: evidence, driverAutomaticRetry: false,
            backendRequestCount: 'UNVERIFIED', serverIdentity: 'UNVERIFIED', accountDebit: 'UNVERIFIED',
            childSessionRetained: true, genericCanaryRepeated: false };
        } finally {
          signal.removeEventListener('abort', abort);
          if (op.childId && !op.ended) {
            interrupt(op);
            await op.end.promise;
          }
          try { op.cancelledParentNoticeIds = consumeOwnNotice(op); }
          finally {
            toolSet?.dispose();
            if (mounted) { await mounted.dispose(); while (mounted.inertia) await mounted.inertia; }
          }
        }
      });
    } finally { await agent.whenIdle(); }
    if (gate.evidence().denials.length !== 0) fail('UNEXPECTED_OWNED_REQUEST');
    return { ...receipt, cancelledParentNoticeIds: op.cancelledParentNoticeIds,
      parentNoticeHandling: 'Only this child settlement notice removed through durable native inbox API during runMaintenance; Session history retained',
      rootQuiescent: agent.status === 'idle', scopedDelegationToolDisposed: true };
  }

  async function handler({ agent, rawInput, signal, attachments }) {
    let op, timer, listener;
    try {
      if (closing) fail('UNLOADING');
      if (rawInput?.trim() !== 'run-one' || !Array.isArray(attachments) || attachments.length !== 0) fail('USAGE_RUN_ONE_ONLY');
      await assertOwned(ctx, config, agent);
      // Unload may have completed while the filesystem checks were awaiting.
      // No await is allowed between this admission fence and publishing active.
      if (closing) fail('UNLOADING');
      signal.throwIfAborted();
      if (active) fail('BUSY');
      if (spent) fail('RUN_ALREADY_ATTEMPTED');
      op = { agent, controller: new AbortController(), end: deferred(), audits: new Map(), ended: false };
      active = op;
      const combined = AbortSignal.any([signal, op.controller.signal]);
      const interrupted = new Promise((_, reject) => {
        listener = () => reject(new LiveError(`${op.controller.signal.reason?.code ?? 'CANCELLED'}_DRAINING_GUARD_RETAINED`));
        combined.addEventListener('abort', listener, { once: true });
      });
      timer = setTimeout(() => op.controller.abort(new LiveError('TIMEOUT')), config.timeoutMs);
      op.done = gate.run(() => perform(op, combined)).finally(() => {
        clearTimeout(timer);combined.removeEventListener('abort', listener);
        if (active === op) active = undefined;
      });
      const receipt = await Promise.race([op.done, interrupted]);
      return { kind: 'success', text: JSON.stringify(receipt) };
    } catch (error) {
      const code = error instanceof LiveError ? error.code : 'HOST_OPERATION_FAILED';
      return { kind: 'error', text: JSON.stringify({ code, childSessionId: op?.childId ?? null,
        callId: op?.callId ?? null, runTag: config.runTag, modelEvidence: gate.evidence(),
        interruptFailed: op?.interruptFailed === true, operationFailure: op?.failure ?? null,
        stopFurtherMutation: true, noAutomaticRetry: true }) };
    }
  }

  ctx.effect(function* () {
    yield unregisterPreset;
    yield ctx.on('llm/stream', gate.hook);
    yield ctx.on('dsh-live-one/role-audit', audit => {
      if (active && audit.parentSessionId === config.ownedSessionId && audit.runTag === config.runTag) active.audits.set(audit.childId, audit);
    });
    yield ctx.on('subagent/start', info => {
      if (info.parentSessionId !== config.ownedSessionId) return;
      const op = active;
      if (!op || !op.dispatching || !gate.inRun() || op.childId || info.provider !== 'spawn' || info.local !== true) {
        gate.blockChild(info.id); if (op) op.failure = 'UNEXPECTED_CHILD'; return;
      }
      const child = ctx.agents.get(info.id);
      op.childId = info.id;op.runId = info.runId;gate.track(info.id);
      if (!child || child.session.header.parentSession !== config.ownedSessionId
        || !childWorkingDirectoryMatches(ctx, config, op.agent, child)
        || ctx.agentPresets.composedPreset(child.ctx) !== config.presetId
        || child.model.current()?.provider !== config.route.provider || child.model.current()?.model !== config.route.model
        || child.model.current()?.reasoningEffort !== 'low' || child.options.maxTokens !== 1024) {
        op.failure = 'CHILD_CONFIGURATION_CHANGED';gate.blockChild(info.id);interrupt(op);
      }
      if (op.controller.signal.aborted) interrupt(op);
    });
    yield ctx.on('subagent/end', info => {
      const op = active;
      if (op && info.id === op.childId && info.runId === op.runId && info.parentSessionId === config.ownedSessionId) {
        op.ended = true;op.end.resolve(info);
      }
    });
    yield async () => {
      closing = true;
      const op = active;
      if (op) { op.controller.abort(new LiveError('UNLOADING'));interrupt(op);await op.done.catch(() => {}); }
    };
    yield ctx.commands.register({ name: 'dsh-subagent-live', description: 'One owned native child; root inference is quarantined while enabled',
      input: { hint: 'run-one', attachments: false }, handler });
  });
}
