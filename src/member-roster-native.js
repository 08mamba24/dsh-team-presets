import { fail, LiveError } from './config.js';
import { validateLauncherTemplate } from './launcher-config.js';
import { observeLauncherMembers } from './launcher-native.js';
import { readReplacementRecord, withMembership, currentRoleOwner } from './member-replacement.js';
import { appendAddition, appendRemoval, settleAddition, rosterOf, additionMemberOf, MEMBER_LIMIT } from './member-roster.js';
import { quietReplacementTree, maintainReplacementTree } from './replacement-native.js';
import { assertRoleToolsAvailable } from './role-tools.js';
import { launcherTemplateFingerprint } from './launcher-template.js';

const UNFINISHED = task => !['completed', 'deleted'].includes(task.status);
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'MEMBER_OPERATION_FAILED';

/** Seed assignment instructions are retained by native command history, not
 * guessed from changed defaults or current task subjects. New launch receipts
 * carry exact ids; rc.7 receipts permit only an unambiguous original subject. */
function seedResponsibilities(root, record, name) {
  const template = validateLauncherTemplate(JSON.parse(record.baseBinding).template);
  const seeds = template.seedTasks.filter(seed => seed.owner === name);
  if (!seeds.length) return new Set();
  const fingerprint = launcherTemplateFingerprint(template);
  const events = root.session.snapshotEvents?.() ?? [];
  const launches = new Set(events.filter(event => event.type === 'command/run'
    && ['dsh-team', 'dsh-team-launcher'].includes(event.data?.name)
    && event.data.args?.trim() === 'launch').map(event => event.data.commandId));
  for (const event of [...events].reverse()) {
    if (event.type !== 'command/done' || event.data?.kind !== 'success' || !launches.has(event.data.commandId)) continue;
    let receipt;
    try { receipt = JSON.parse(event.data.text); } catch { continue; }
    if (receipt?.ok !== true || receipt.mode !== 'launch' || receipt.templateFingerprint !== fingerprint) continue;
    const ids = [];
    for (const seed of seeds) {
      const matches = Array.isArray(receipt.seedAssignments)
        ? receipt.seedAssignments.filter(row => row.key === seed.key && row.owner === name).map(row => row.taskId)
        : (receipt.tasks ?? []).filter(task => task.subject === seed.subject).map(task => task.id);
      if (matches.length !== 1 || typeof matches[0] !== 'string' || !matches[0]) fail('MEMBER_TASK_RESPONSIBILITY_UNVERIFIABLE');
      ids.push(matches[0]);
    }
    if (new Set(ids).size !== ids.length) fail('MEMBER_TASK_RESPONSIBILITY_UNVERIFIABLE');
    return new Set(ids);
  }
  fail('MEMBER_TASK_RESPONSIBILITY_UNVERIFIABLE');
}

/** Normalize one explicit member to the bound root's Preset naming; launcher rules apply unchanged. */
export function normalizeAddedMember(raw, runTag) {
  if (typeof runTag !== 'string' || !/^current-[a-f0-9]{24}$/.test(runTag)) fail('MEMBER_CURRENT_SESSION_REQUIRED');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.name !== 'string') fail('MEMBER_REQUEST_INVALID');
  const member = { ...raw, agent_preset: `dsh-current-${runTag.slice('current-'.length)}-${raw.name}` };
  validateLauncherTemplate({ template_schema: 'dsh-team-template/1', version: 1, name: 'member-addition', max_members: 1, members: [member] });
  return member;
}

/** Explicit add/remove for an already launched current-session team. Every
 * other member, task, dependency and Session history is left untouched. */
export function createRosterRuntime(ctx, config, { baseMembers, store, registerMember, lifetimeSignal }) {
  const startupPrompt = member => `${member.prompt}\n\nYou were added to an existing native team as member ${JSON.stringify(member.name)}. `
    + 'Confirm readiness with your role name, then end this turn. Do not claim or change tasks until the Lead assigns work.';

  async function addMember(root, requestSignal, raw) {
    const signal = AbortSignal.any([requestSignal, lifetimeSignal]);
    const member = normalizeAddedMember(raw, config.runTag);
    const row = store.read({ requirePartition: true }), record = readReplacementRecord(row.value);
    if (record.baseBinding === undefined || !ctx.agentTeams.isEnabled(root)) fail('MEMBER_TEAM_NOT_LAUNCHED');
    const roster = rosterOf(record, baseMembers);
    if (roster.names.has(member.name) || roster.removed.some(entry => entry.name === member.name)
      || record.operations.some(op => op.role === member.name || op.instanceName === member.name)) fail('MEMBER_NAME_CONFLICT');
    if (roster.members.length >= MEMBER_LIMIT) fail('MEMBER_LIMIT_REACHED');
    const catalog = await observeLauncherMembers(ctx, root, signal);
    if (catalog.complete !== true) fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
    if (catalog.members.some(entry => entry.name === member.name)) fail('MEMBER_NAME_CONFLICT');
    // Native policy, tool catalog and adapter metadata decide admission before any write.
    const assertAdmission = () => {
      signal.throwIfAborted();
      if (ctx.agents.get(root.id) !== root || !ctx.agentTeams.isEnabled(root)) fail('MEMBER_TEAM_NOT_LAUNCHED');
      const policy = ctx.sessionProjections.stateOf(root.session, 'subagentModelSelectionPolicy');
      if (!Array.isArray(policy) || !policy.some(route => route.provider === member.provider && route.model === member.model)) fail('SESSION_ROUTE_NOT_AUTHORIZED');
      assertRoleToolsAvailable(ctx, root, [member.native_tool_allowlist]);
    };
    assertAdmission();
    const route = { provider: member.provider, model: member.model, reasoningEffort: member.reasoning_effort };
    const resolved = await ctx.llm.resolveCallConfig(route, signal);
    if (!['provider', 'model', 'reasoningEffort'].every(key => resolved[key] === route[key])) fail('RESOLVED_CONTROLS_CHANGED');
    if (typeof ctx.subagents.startActivation !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
    assertAdmission();
    const { entry, membership } = appendAddition(record.membership ?? [], { name: member.name, member });
    if (!await store.write(withMembership(record, membership), row.revision)) fail('REPLACEMENT_PERSISTENCE_CONFLICT');
    let activation;
    try {
      await registerMember(entry);
      assertAdmission();
      activation = await ctx.subagents.startActivation({ provider: 'spawn', parent: root, childId: entry.childId,
        name: member.name, label: `Team member ${member.name}`, cwd: config.workspace, agentPreset: member.agent_preset,
        agentOptions: { ...route, maxTokens: 1024 }, prompt: [{ type: 'text', text: startupPrompt(member) }], signal, delivery: 'parent', maxDepth: 1 });
      if (activation.childId !== entry.childId) fail('MEMBER_IDENTITY_CHANGED');
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const ended = await Promise.race([activation.result, new Promise((_, reject) => {
        timeout.addEventListener('abort', () => reject(new LiveError('MEMBER_STARTUP_TIMEOUT')), { once: true });
      })]);
      if (ended?.stopReason !== 'completed') fail('MEMBER_STARTUP_NOT_COMPLETED');
      const source = await ctx.sessionQuery.observeSession(entry.childId, { signal });
      try {
        if (source.header?.id !== entry.childId || source.header.parentSession !== root.id
          || source.header.agentPreset !== member.agent_preset || source.header.cwd !== config.workspace) fail('MEMBER_IDENTITY_CHANGED');
      } finally { source[Symbol.dispose](); }
      assertAdmission();
      await settle(entry.id, 'active');
      return { ok: true, action: 'add', name: member.name, childId: entry.childId, agentPreset: member.agent_preset,
        route, tools: [...member.native_tool_allowlist].sort(), entryId: entry.id };
    } catch (error) {
      // Only the new member is stopped; other members and tasks were never touched.
      if (ctx.agents.get(entry.childId)) {
        try { ctx.subagents.interrupt(entry.childId, { kind: 'ancestor', agent: root }); await ctx.agents.get(entry.childId)?.whenIdle(); }
        catch { /* settlement is re-observed below and reported */ }
      }
      try { await activation?.dispose?.(); } catch { /* native manager owns activation logs */ }
      let settled = false;
      try { await settle(entry.id, activation ? 'failed' : 'aborted'); settled = true; } catch { /* reported */ }
      throw Object.assign(new LiveError(codeOf(error)), { memberEntryId: entry.id, memberStateConfirmed: settled });
    }
  }

  async function settle(entryId, phase) {
    const row = store.read({ requirePartition: true }), record = readReplacementRecord(row.value);
    if (!await store.write(withMembership(record, settleAddition(record.membership, entryId, phase)), row.revision)) {
      fail('REPLACEMENT_PERSISTENCE_CONFLICT');
    }
  }

  async function removeMember(root, requestSignal, name) {
    const signal = AbortSignal.any([requestSignal, lifetimeSignal]);
    const row = store.read({ requirePartition: true }), record = readReplacementRecord(row.value);
    if (record.baseBinding === undefined) fail('MEMBER_TEAM_NOT_LAUNCHED');
    const target = rosterOf(record, baseMembers).members.find(row => row.name === name);
    if (!target) fail('MEMBER_NOT_FOUND');
    if (record.operations.some(op => op.role === name && !['active', 'aborted'].includes(op.phase))) fail('REPLACEMENT_ROLE_BUSY');
    const mapped = currentRoleOwner(record, name);
    const catalog = await observeLauncherMembers(ctx, root, signal);
    if (catalog.complete !== true) fail('REPLACEMENT_MEMBER_UNOBSERVABLE');
    const live = catalog.members.find(entry => mapped ? entry.id === mapped : entry.name === name);
    const childId = live?.id ?? (target.origin === 'added' ? target.childId : null);
    const memberIds = new Set([childId, ...record.operations.filter(op => op.role === name)
      .flatMap(op => [op.oldChildId, op.newChildId])].filter(Boolean));
    let seedIds;
    const tasksNow = (afterRemoval = false) => {
      signal.throwIfAborted();
      if (!ctx.agentTeams.isEnabled(root)) fail('MEMBER_TEAM_NOT_LAUNCHED');
      const tasks = ctx.agentTeams.listTasks(root);
      if (!Array.isArray(tasks)) fail('MEMBER_TASK_RESPONSIBILITY_UNVERIFIABLE');
      const unfinished = tasks.filter(UNFINISHED);
      if (unfinished.some(task => task.ownerId === undefined)) seedIds ??= seedResponsibilities(root, record, name);
      const owned = unfinished.filter(task => memberIds.has(task.ownerId)
        || task.ownerId === undefined && seedIds?.has(task.id));
      if (owned.length) throw Object.assign(new LiveError(afterRemoval ? 'MEMBER_REMOVAL_TASK_CONFLICT' : 'MEMBER_HAS_UNFINISHED_TASKS'),
        { taskIds: owned.map(task => task.id) });
      return tasks;
    };
    const tasks = tasksNow();
    const write = async () => {
      const current = store.read({ requirePartition: true });
      if (current.revision !== row.revision) fail('REPLACEMENT_PERSISTENCE_CONFLICT');
      tasksNow();
      const { membership } = appendRemoval(record.membership ?? [], { name, childId });
      if (!await store.write(withMembership(record, membership), row.revision)) fail('REPLACEMENT_PERSISTENCE_CONFLICT');
      // A racing native task writer cannot turn a durable fence into a success
      // receipt that silently abandons work. Keep the fence and report conflict.
      tasksNow(true);
    };
    // Holding every resident member phase blocks a wake between the quiet check and the durable fence.
    if (live) await maintainReplacementTree(ctx, root, live.id, signal, write, await quietReplacementTree(ctx, root, live.id, signal));
    else await write();
    return { ok: true, action: 'remove', name, childId, retainedTaskIds: tasks.map(task => task.id) };
  }

  /** Re-register every bound addition's Preset before a cold member can continue. */
  async function restore(record) {
    for (const entry of record.membership ?? []) if (entry.kind === 'add' && entry.phase !== 'aborted') await registerMember(entry);
  }

  return { addMember, removeMember, restore, rosterOf: record => rosterOf(record, baseMembers), additionMemberOf };
}
