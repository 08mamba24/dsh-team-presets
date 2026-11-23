import { readAuthorizedRoutes } from './host-adapter.js';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { fail } from './config.js';
import { registerLauncherPresets, observeLauncherMembers } from './launcher-native.js';
import { assertRoleToolsAvailable } from './role-tools.js';
import { createReplacementStore, REPLACEMENT_OWNER } from './replacement-store.js';
import { readReplacementRecord, eligibilityOf, replacementCandidateOf } from './member-replacement.js';
import { additionMemberOf } from './member-roster.js';

const queued = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn];
const textOf = message => Array.isArray(message?.content) && message.content.length > 0
  && message.content.every(block => block?.type === 'text' && typeof block.text === 'string')
  ? message.content.at(-1).text : undefined;

/** The native relay prepends its address as a separate text block. Authenticate
 * the runtime source, then parse only the sender's exact JSON payload. */
export function nativeReadiness(messages, operation) {
  for (const message of messages) {
    if (message.source?.kind !== 'agent-message' || message.source.form !== 'relay'
      || message.source.senderSessionId !== operation.newChildId) continue;
    const text = textOf(message);
    let ack;
    try { ack = JSON.parse(text); } catch { continue; }
    if (!ack || typeof ack !== 'object' || Array.isArray(ack)
      || Object.keys(ack).length !== (operation.configDigest === undefined ? 3 : 4)
      || ack.ready !== true || ack.operation !== operation.id || ack.handoff !== operation.handoffDigest
      || (operation.configDigest !== undefined && ack.config !== operation.configDigest)) continue;
    return { text, senderSessionId: message.source.senderSessionId, messageId: message.id };
  }
}

/** Inspect a child's own native tool call/result pairs. An owner field by itself,
 * an assistant claim or a failed/stale write is never a takeover receipt. */
export function nativeTaskWrites(events, childId, operation) {
  if (typeof operation.instanceName !== 'string' || childId !== operation.newChildId) return [];
  const calls = new Map(), writes = [];
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'team_task_update') {
      try {
        const args = JSON.parse(event.data.arguments);
        if (typeof args.task_id === 'string' && Number.isSafeInteger(args.expected_revision)
          && ['claim', 'edit', 'complete'].includes(args.action)) calls.set(event.data.callId, { args, seq: event.seq });
      } catch { /* Invalid calls do not prove a task write. */ }
    } else if (event.type === 'tool/result') {
      const result = event.data?.message, call = calls.get(result?.toolCallId);
      if (!call) continue;
      calls.delete(result.toolCallId);
      if (result.isError === true) continue;
      let task;
      try { task = JSON.parse(textOf(result)); } catch { continue; }
      // Retained pre-projection native results use the physical instance name;
      // current native TaskView uses its stable logical role. Identity comes
      // from the candidate's own Session, then the live Board owner is checked
      // before persisting proof. A display name alone grants no authority.
      const ownName = task?.owner === operation.instanceName
        || task?.owner === operation.role;
      if (task?.id !== call.args.task_id || !ownName
        || task.revision !== call.args.expected_revision + 1) continue;
      writes.push({ childId, operationId: operation.id, handoffDigest: operation.handoffDigest,
        taskId: task.id, revision: task.revision, expectedRevision: call.args.expected_revision,
        callId: result.toolCallId, callSeq: call.seq, resultSeq: event.seq,
        action: call.args.action, success: true });
    }
  }
  return writes;
}

async function replacementSession(ctx, childId, signal) {
  if (typeof ctx.sessionQuery?.observeSession !== 'function') fail('REPLACEMENT_SESSION_UNOBSERVABLE');
  const source = await ctx.sessionQuery.observeSession(childId, { signal });
  try {
    signal.throwIfAborted();
    if (source.header?.id !== childId || !Array.isArray(source.events)
      || !Number.isSafeInteger(source.inheritedEventCount) || source.inheritedEventCount < 0) fail('REPLACEMENT_SESSION_UNOBSERVABLE');
    return { events: source.events.slice(source.inheritedEventCount), header: source.header,
      inbox: source.projections?.values?.inbox };
  } finally { source[Symbol.dispose](); }
}

export async function ownSessionEvents(ctx, childId, signal) {
  return (await replacementSession(ctx, childId, signal)).events;
}

/** Complete catalog ancestry plus real Agent/job/session evidence. */
export async function quietReplacementTree(ctx, root, childId, signal) {
  if (ctx.agents.get(root.id) !== root) fail('WRONG_AGENT');
  const rows = await ctx.subagents.listDescendants(root.id, signal);
  if (!Array.isArray(rows)) fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
  const nodes = new Map([[root.id, { depth: 0 }]]), subtree = [];
  for (const row of rows) {
    if (row?.kind !== 'child' || !['continuable', 'one-shot', 'external'].includes(row.mode)
      || !['running', 'inactive'].includes(row.activity) || typeof row.id !== 'string' || nodes.has(row.id)
      || !nodes.has(row.parentId) || row.depth !== nodes.get(row.parentId).depth + 1) fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
    const selected = row.id === childId || nodes.get(row.parentId).selected === true;
    nodes.set(row.id, { depth: row.depth, selected });
    if (selected) subtree.push(row);
  }
  if (!subtree.length || subtree[0].id !== childId || subtree[0].parentId !== root.id) fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
  const jobs = ctx.get?.('jobs');
  const live = [], observations = [];
  for (const row of subtree) {
    signal.throwIfAborted();
    if (row.mode !== 'continuable') fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
    let jobSnapshot;
    if (jobs !== undefined) {
      if (typeof jobs.list !== 'function') fail('REPLACEMENT_BACKGROUND_UNOBSERVABLE');
      const work = jobs.list(row.id);
      if (!Array.isArray(work)) fail('REPLACEMENT_BACKGROUND_UNOBSERVABLE');
      if (work.some(job => job.owner === row.id && ['running', 'stopping'].includes(job.status))) fail('REPLACEMENT_BACKGROUND_ACTIVE');
      jobSnapshot = structuredClone(work.filter(job => job.owner === row.id));
    }
    const agent = ctx.agents.get(row.id);
    if (agent !== undefined) {
      if (agent.session?.id !== row.id || agent.session.header?.parentSession !== row.parentId
        || agent.status !== 'idle' || queued(agent).length !== 0
        || typeof agent.runMaintenance !== 'function') fail('REPLACEMENT_MEMBER_NOT_QUIET');
      live.push(agent);
      const events = agent.session.snapshotEvents();
      observations.push({ row: structuredClone(row), events: events.length,
        lastSeq: events.at(-1)?.seq ?? null, jobs: jobSnapshot });
    } else {
      if (row.activity !== 'inactive') fail('REPLACEMENT_MEMBER_NOT_QUIET');
      const { events, inbox } = await replacementSession(ctx, row.id, signal);
      if (!inbox || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])
        || inbox['next-turn'].length || inbox['next-step'].length) fail('REPLACEMENT_MEMBER_NOT_QUIET');
      const start = events.findLast(event => event.type === 'turn/start');
      const end = events.findLast(event => event.type === 'turn/end');
      if (start && (!end || start.seq > end.seq)) fail('REPLACEMENT_MEMBER_NOT_QUIET');
      if (ctx.agents.get(row.id) !== undefined) fail('REPLACEMENT_MEMBER_NOT_QUIET');
      observations.push({ row: structuredClone(row), events: events.length,
        lastSeq: events.at(-1)?.seq ?? null, jobs: jobSnapshot });
    }
  }
  if (ctx.agents.get(root.id) !== root) fail('WRONG_AGENT');
  return { ids: subtree.map(row => row.id), live, observations };
}

/** Claim all resident idle phases; cold members remain fenced by the durable
 * frozen write and the post-write re-observation. The root may be in a tool. */
export async function maintainReplacementTree(ctx, root, childId, signal, body, expected) {
  const before = await quietReplacementTree(ctx, root, childId, signal);
  if (expected && !isDeepStrictEqual(expected.observations, before.observations)) fail('REPLACEMENT_SNAPSHOT_STALE');
  const enter = index => {
    if (index === before.live.length) return (async () => {
      const result = await body();
      const after = await quietReplacementTree(ctx, root, childId, signal);
      if (!isDeepStrictEqual(before.observations, after.observations)) fail('REPLACEMENT_SNAPSHOT_STALE');
      return result;
    })();
    const agent = before.live[index];
    if (ctx.agents.get(agent.id) !== agent) fail('REPLACEMENT_MEMBER_NOT_QUIET');
    return agent.runMaintenance(async maintenanceSignal => {
      maintenanceSignal.throwIfAborted(); signal.throwIfAborted();
      const result = await enter(index + 1);
      maintenanceSignal.throwIfAborted(); signal.throwIfAborted();
      return result;
    });
  };
  return enter(0);
}

export async function pollReplacement(signal, timeoutMs, inspect, code) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal.throwIfAborted();
    const result = await inspect();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) fail(code);
    await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

const persistedMessages = events => events.flatMap(event => event.type === 'user/message' ? [event.data]
  : event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted) ? event.data.inserted : []);

/** One binding owns its Preset registrations for its complete lifetime. The
 * native manager owns child activation, continuation, cancellation and logs. */
export function createReplacementRuntime(ctx, config, controlEntry) {
  const presets = new Map(), activations = new Map(), runs = new Map(), candidateIds = new Set();
  const lifetime = new AbortController();
  let closing = false;
  ctx.on('subagent/start', info => {
    if (info?.parentSessionId === config.ownedSessionId) runs.set(info.id, { ...info, ended: false });
  });
  ctx.on('subagent/end', info => {
    const run = runs.get(info?.id);
    if (run?.runId === info.runId) runs.set(info.id, { ...info, ended: true });
  });
  const requestOf = operation => replacementCandidateOf(operation).request;
  const reserveId = operation => replacementCandidateOf(operation).childId;
  async function register(operation) {
    const request = requestOf(operation);
    candidateIds.add(operation.newChildId ?? reserveId(operation));
    const definition = JSON.stringify({ operationId: operation.id, request, name: operation.instanceName });
    const previous = presets.get(operation.presetId);
    if (previous) {
      if (previous.definition !== definition) fail('REPLACEMENT_CANDIDATE_CONFIG_CHANGED');
      return previous.ready;
    }
    const entry = { definition };
    presets.set(operation.presetId, entry);
    entry.ready = registerLauncherPresets(ctx, { ownedSessionId: config.ownedSessionId, replacementOwner: REPLACEMENT_OWNER },
      { members: [{ name: operation.instanceName, agentPreset: operation.presetId,
        personaPrompt: request.personaPrompt, nativeToolAllowlist: request.tools,
        standbyOperationId: operation.id }] }, controlEntry).then(disposers => { entry.disposers = disposers; });
    return entry.ready;
  }
  /** An explicit team addition owns one exact Preset for this binding's lifetime. */
  async function registerMember(entry) {
    const member = additionMemberOf(entry);
    candidateIds.add(entry.childId);
    const definition = JSON.stringify({ memberEntry: entry.id, member });
    const previous = presets.get(member.agent_preset);
    if (previous) {
      if (previous.definition !== definition) fail('MEMBER_CONFIG_CHANGED');
      return previous.ready;
    }
    const record = { definition };
    presets.set(member.agent_preset, record);
    record.ready = registerLauncherPresets(ctx, { ownedSessionId: config.ownedSessionId, replacementOwner: REPLACEMENT_OWNER },
      { members: [{ name: member.name, agentPreset: member.agent_preset, personaPrompt: member.persona_prompt,
        nativeToolAllowlist: member.native_tool_allowlist }] }, controlEntry).then(disposers => { record.disposers = disposers; });
    return record.ready;
  }
  async function dispose() {
    if (closing) return;
    closing = true; lifetime.abort(Object.assign(new Error('UNLOADING'), { code: 'UNLOADING' }));
    const root = ctx.agents.get(config.ownedSessionId);
    if (root) {
      for (const id of candidateIds) {
        const child = ctx.agents.get(id);
        if (child?.session.header.parentSession === root.id) ctx.subagents.interrupt(id, { kind: 'ancestor', agent: root });
      }
      await Promise.all([...candidateIds].map(id => ctx.agents.get(id)?.whenIdle()));
    }
    for (const activation of activations.values()) await activation.dispose();
    for (const entry of [...presets.values()].reverse()) {
      await entry.ready.catch(() => {});
      for (const dispose of [...entry.disposers ?? []].reverse()) await dispose();
    }
  }
  return {
    dispose, registerMember, signal: lifetime.signal,
    async restorePresets(record) {
      for (const operation of record.operations) if (operation.candidateConfig !== undefined) await register(operation);
    },
    host(root, requestSignal, { expectedOldChildId } = {}) {
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      const store = createReplacementStore(ctx.settings, config.ownedSessionId);
      let observedChildId, observedTree;
      const assertRoot = () => {
        if (root.id !== config.ownedSessionId || ctx.agents.get(root.id) !== root
          || root.session?.id !== root.id || root.session.header?.origin === 'subagent') fail('WRONG_AGENT');
      };
      const assertCurrent = () => { assertRoot(); signal.throwIfAborted(); if (closing) fail('UNLOADING'); };
      const assertRequestAdmission = request => {
        assertCurrent();
        const policy = readAuthorizedRoutes(ctx, root.session);
        if (!policy.some(route => route.provider === request.provider && route.model === request.model)) fail('REPLACEMENT_ROUTE_UNAUTHORIZED');
        assertRoleToolsAvailable(ctx, root, [request.tools]);
      };
      const operationNow = id => {
        assertRoot();
        const operation = readReplacementRecord(store.read({ requirePartition: true }).value).operations.find(item => item.id === id);
        if (!operation) fail('REPLACEMENT_OPERATION_NOT_FOUND');
        return operation;
      };
      const catalog = async () => {
        assertCurrent();
        const value = await observeLauncherMembers(ctx, root, signal);
        if (value.complete !== true) fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
        return value.members;
      };
      const ownMessages = async id => {
        const agent = ctx.agents.get(id);
        const events = agent?.session.snapshotEvents() ?? await ownSessionEvents(ctx, id, signal);
        return [...persistedMessages(events), ...agent === undefined ? [] : queued(agent)];
      };
      const clean = async (childId, operationId, requireCompleted, cleanSignal = signal) => pollReplacement(cleanSignal, config.timeoutMs, async () => {
        const run = runs.get(childId);
        if (ctx.agents.get(childId) !== undefined || (run && !run.ended)) return;
        if (requireCompleted && run && run.stopReason !== 'completed') fail('REPLACEMENT_CANDIDATE_FAILED');
        await quietReplacementTree(ctx, root, childId, cleanSignal);
        if (requireCompleted && !run) {
          const end = (await ownSessionEvents(ctx, childId, cleanSignal)).findLast(event => event.type === 'turn/end');
          if (end?.data?.reason?.kind !== 'completed') fail('REPLACEMENT_CANDIDATE_FAILED');
        }
        operationNow(operationId);
        return true;
      }, 'REPLACEMENT_CANDIDATE_NOT_SETTLED');
      const restore = async operation => {
        await register(operation);
        const matches = (await catalog()).filter(member => member.name === operation.instanceName);
        if (matches.length === 0) return { found: false };
        const member = matches[0];
        if (matches.length !== 1 || member.id !== (operation.newChildId ?? reserveId(operation))) fail('REPLACEMENT_CANDIDATE_IDENTITY_CHANGED');
        const snapshot = await replacementSession(ctx, member.id, signal);
        if (snapshot.header.parentSession !== root.id || snapshot.header.agentPreset !== operation.presetId) fail('REPLACEMENT_CANDIDATE_IDENTITY_CHANGED');
        return { found: true, childId: member.id };
      };
      return {
        signal, now: () => Date.now(), ownedSessionId: () => root.id,
        readRecord: () => { assertRoot(); return store.read({ requirePartition: true }); },
        writeRecord: (_rootId, value, revision) => { assertRoot(); return store.write(value, revision); },
        async preflight(request) {
          assertRequestAdmission(request);
          const route = { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort };
          const resolved = await ctx.llm.resolveCallConfig(route, signal);
          assertRequestAdmission(request);
          if (!['provider', 'model', 'reasoningEffort'].every(key => resolved[key] === route[key])) fail('RESOLVED_CONTROLS_CHANGED');
          const provider = ctx.subagents.getProvider('spawn');
          if (typeof ctx.subagents.startActivation !== 'function' || !provider?.capabilities?.agentOptions
            || !provider.capabilities.agentPreset || !provider.capabilities.depthLimit) fail('REPLACEMENT_HOST_UNAVAILABLE');
        },
        async uniqueInstanceName(role) {
          const taken = new Set((await catalog()).map(member => member.name));
          for (const operation of readReplacementRecord(store.read().value).operations) taken.add(operation.instanceName);
          let number = 1; while (taken.has(`${role}-r${number}`)) number++;
          return `${role}-r${number}`;
        },
        async observeMember(role, expectedChildId) {
          const record = readReplacementRecord(store.read({ requirePartition: true }).value);
          const current = record.operations.findLast(operation => operation.role === role && operation.phase === 'active'
            && eligibilityOf(record, operation.newChildId).kind === 'full');
          const member = (await catalog()).find(item => current ? item.id === current.newChildId : item.name === role);
          if (!member || (expectedOldChildId !== undefined && member.id !== expectedOldChildId)
            || (expectedChildId !== undefined && member.id !== expectedChildId)) return { available: false };
          observedTree = await quietReplacementTree(ctx, root, member.id, signal);
          observedChildId = member.id;
          return { available: true, quiet: true, childId: member.id };
        },
        async listTasks() {
          assertRoot();
          const tasks = ctx.agentTeams.listTasks(root), byId = new Map(tasks.map(task => [task.id, task]));
          // Native reassign refuses blocked tasks even if they are in_progress.
          // Refuse before freezing rather than enter recovery on a known refusal.
          if (tasks.some(task => task.ownerId === observedChildId && !['completed', 'deleted'].includes(task.status)
            && task.blockedBy.some(id => byId.get(id)?.status !== 'completed'))) fail('REPLACEMENT_TASK_BLOCKED');
          return tasks;
        },
        async getTask(id) {
          assertRoot();
          try { return ctx.agentTeams.getTask(root, id); }
          catch (error) { if (error?.code === 'TEAM_TASK_NOT_FOUND') return undefined; throw error; }
        },
        async reassignTask({ taskId, expectedRevision, owner }) {
          assertRoot();
          await ctx.agentTeams.updateTask(root, { taskId, expectedRevision, action: 'reassign', owner }, signal);
          return true;
        },
        runMaintenanceExclusive: (childId, body) => maintainReplacementTree(ctx, root, childId, signal, body, observedTree),
        async assertMemberStillQuiet(_role, childId, evidence) {
          await quietReplacementTree(ctx, root, childId, signal);
          if (evidence?.phase === 'post-freeze') {
            for (const ref of evidence.taskRefs) {
              const task = ctx.agentTeams.getTask(root, ref.taskId);
              const stable = value => {
                const copy = structuredClone(value);
                Reflect.deleteProperty(copy, 'ready'); Reflect.deleteProperty(copy, 'writeScopeWarnings');
                return copy;
              };
              if (task?.ownerId !== childId || task.revision !== ref.revision
                || (ref.snapshot !== undefined && !isDeepStrictEqual(stable(task), stable(ref.snapshot)))) fail('REPLACEMENT_SNAPSHOT_STALE');
            }
          }
        },
        async spawnCandidate({ request, operation }) {
          assertCurrent(); await register(operation);
          // Cover the cold-member observation-to-persistence race: no candidate
          // is created until the now-frozen old tree is still confirmed quiet.
          await quietReplacementTree(ctx, root, operation.oldChildId, signal);
          if ((await restore(operation)).found) fail('REPLACEMENT_CANDIDATE_ALREADY_EXISTS');
          const ack = { ready: true, operation: operation.id, handoff: operation.handoffDigest, config: operation.configDigest };
          const prompt = `${request.prompt}\n\n${operation.handoffText}\n\nStandby operation ${operation.id}. Read every handoff task with team_task_get. Send exactly ${JSON.stringify(ack)} to lead with send_message, then end this turn. Do not modify work before activation.`;
          assertRequestAdmission(request);
          const activation = await ctx.subagents.startActivation({ provider: 'spawn', parent: root,
            childId: reserveId(operation), name: operation.instanceName, label: `Replacement ${operation.role}`,
            cwd: config.workspace, agentPreset: operation.presetId,
            agentOptions: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort },
            prompt: [{ type: 'text', text: prompt }], signal, delivery: 'parent', maxDepth: 1 });
          activations.set(operation.id, activation);
          void activation.result.catch(() => {});
          if (activation.childId !== reserveId(operation)) fail('REPLACEMENT_CANDIDATE_IDENTITY_CHANGED');
          return { childId: activation.childId };
        },
        restoreCandidate: ({ operation }) => restore(operation),
        awaitReadiness: (childId, operationId) => pollReplacement(signal, config.timeoutMs, async () => {
          const operation = operationNow(operationId);
          if (operation.newChildId !== childId) fail('REPLACEMENT_CANDIDATE_IDENTITY_CHANGED');
          return nativeReadiness(await ownMessages(root.id), operation);
        }, 'REPLACEMENT_ACK_TIMEOUT'),
        assertCandidateClean: (childId, operationId) => clean(childId, operationId, true),
        async cancelCandidate({ operation, childId }) {
          assertRoot();
          const found = childId === undefined || childId === null ? await restore(operation) : { found: true, childId };
          if (found.found) {
            ctx.subagents.interrupt(found.childId, { kind: 'ancestor', agent: root });
            const activation = activations.get(operation.id);
            if (activation) await activation.dispose();
            await clean(found.childId, operation.id, false, AbortSignal.timeout(config.timeoutMs));
          } else if (ctx.agents.get(reserveId(operation)) !== undefined) fail('REPLACEMENT_CANDIDATE_IDENTITY_CHANGED');
          for (const ref of operation.taskRefs) {
            let task;
            try { task = ctx.agentTeams.getTask(root, ref.taskId); }
            catch (error) { if (error?.code === 'TEAM_TASK_NOT_FOUND') continue; throw error; }
            if (!['completed', 'deleted'].includes(task.status) && task.ownerId !== operation.oldChildId) return { settled: false };
          }
          return { settled: true };
        },
        async activateCandidate({ operation, request }) {
          assertCurrent(); await register(operation);
          const current = operationNow(operation.id);
          if (!['activating', 'active'].includes(current.phase) || current.newChildId !== operation.newChildId) fail('REPLACEMENT_ACTIVE_CHANGED');
          const marker = `Replacement activation ${operation.id}; handoff ${operation.handoffDigest}; config ${operation.configDigest}.`;
          const accepted = (await ownMessages(operation.newChildId)).find(message => message.source?.kind === 'agent-message'
            && message.source.senderSessionId === root.id && textOf(message)?.startsWith(marker + '\n'));
          if (accepted) {
            const live = ctx.agents.get(operation.newChildId);
            const prior = nativeTaskWrites(await ownSessionEvents(ctx, operation.newChildId, signal), operation.newChildId, operation);
            if (live?.status === 'running' || prior.some(write => operation.taskOutcomes.some(outcome =>
              outcome.kind === 'transferred' && outcome.taskId === write.taskId && outcome.revision <= write.expectedRevision))) {
              return { childId: operation.newChildId, messageId: accepted.id };
            }
          }
          const continuation = accepted
            ? `Continue recovery in this same Session. Read your existing tool results and the task board, preserve successful work, and do not repeat completed effects. Original requested work: ${request.prompt}`
            : request.prompt;
          const messageId = await ctx.subagents.sendMessage(root, operation.newChildId,
            [{ type: 'text', text: `${marker}\n${continuation}\nContinue your transferred tasks now. Preserve existing progress and dependencies; report a real team_task_update after doing useful work.` }], { signal });
          return { childId: operation.newChildId, messageId };
        },
        observeTakeover: ({ operation, transferred }) => pollReplacement(signal, config.timeoutMs, async () => {
          const current = operationNow(operation.id);
          if (!['activating', 'active'].includes(current.phase) || current.newChildId !== operation.newChildId) fail('REPLACEMENT_ACTIVE_CHANGED');
          const events = await ownSessionEvents(ctx, operation.newChildId, signal);
          const writes = nativeTaskWrites(events, operation.newChildId, operation);
          const proof = writes.find(write => transferred.some(entry => entry.kind === 'transferred'
            && entry.taskId === write.taskId && entry.revision <= write.expectedRevision));
          if (!proof) {
            const run = runs.get(operation.newChildId);
            if (run?.ended && run.stopReason !== 'completed') fail('REPLACEMENT_CANDIDATE_FAILED');
            return;
          }
          const task = ctx.agentTeams.getTask(root, proof.taskId);
          if (task.ownerId !== operation.newChildId || task.revision < proof.revision) fail('REPLACEMENT_TAKEOVER_OWNER_CHANGED');
          const live = ctx.agents.get(operation.newChildId);
          if (live && await ctx.sessions.flush(live.session) !== true) fail('REPLACEMENT_TAKEOVER_PERSISTENCE_UNCONFIRMED');
          return proof;
        }, 'REPLACEMENT_TAKEOVER_PENDING'),
      };
    },
  };
}
