import { readAuthorizedRoutes } from './host-adapter.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fail, sameControls } from './config.js';
import { validateLauncherTemplate } from './launcher-config.js';
import { launcherTemplateFingerprint } from './launcher-template.js';
import { assertRoleToolsAvailable, roleToolCatalog, validRoleToolList } from './role-tools.js';

const NS = 'dsh-native-current-team';
const MEMBER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TEMPLATE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const FIELDS = ['provider', 'model', 'reasoning_effort', 'description', 'persona_prompt', 'prompt', 'native_tool_allowlist', 'role'];
// Duty-template fields copied into a newly added member when the edit omits them.
const DEFAULTED = ['description', 'persona_prompt', 'prompt', 'native_tool_allowlist'];
const ROUTE_FIELDS = ['provider', 'model', 'reasoning_effort'];
const RECORD_FIELDS = ['id', 'description', 'persona_prompt', 'prompt', 'native_tool_allowlist'];
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = raw => launcherTemplateFingerprint(validateLauncherTemplate(raw));
const errorCode = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'TEAM_CONFIGURATION_FAILED';

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
// Record order and allowlist order never change duty-template identity.
const customsIdentity = customs => canonical(customs.map(item => ({ ...item,
  native_tool_allowlist: [...item.native_tool_allowlist].sort() }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
/** Preview/apply identity covers the member template and the custom duty-template
 * catalog together; either side changing invalidates the other side's preview. */
const configureFingerprint = (template, customs) => createHash('sha256')
  .update(`dsh-native-team-configure/1\0${fingerprint(template)}\0${customsIdentity(customs)}`, 'utf8').digest('hex');

function checkTemplateRecord(value) {
  if (!record(value) || Object.keys(value).length !== RECORD_FIELDS.length || !RECORD_FIELDS.every(key => own(value, key))) fail('INVALID_CUSTOM_TEMPLATES');
  if (typeof value.id !== 'string' || !TEMPLATE_ID.test(value.id)) fail('INVALID_CUSTOM_TEMPLATES');
  if (value.id === 'lead') fail('CUSTOM_TEMPLATE_ID_RESERVED');
  if (typeof value.description !== 'string' || value.description.trim().length === 0 || [...value.description].length > 200
    || value.description.includes('\0')) fail('INVALID_CUSTOM_TEMPLATES');
  for (const key of ['persona_prompt', 'prompt']) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0 || [...value[key]].length > 8000
      || value[key].includes('\0')) fail('INVALID_CUSTOM_TEMPLATES');
  }
  if (!validRoleToolList(value.native_tool_allowlist)) fail('INVALID_CUSTOM_TEMPLATES');
}

/** The pure duty-template library owns built-in data and custom validation; this
 * layer re-derives the structural guarantees so a persisted row stays loadable. */
function normalizeCustoms(raw, library) {
  if (!Array.isArray(raw) || raw.length > 32) fail('INVALID_CUSTOM_TEMPLATES');
  let validated;
  try { validated = library.validateCustomRoleTemplates(raw); } catch (error) {
    fail(/^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'INVALID_CUSTOM_TEMPLATES');
  }
  if (!Array.isArray(validated) || validated.length !== raw.length) fail('INVALID_CUSTOM_TEMPLATES');
  const seen = new Set();
  for (const item of validated) {
    checkTemplateRecord(item);
    if (seen.has(item.id)) fail('INVALID_CUSTOM_TEMPLATES');
    seen.add(item.id);
  }
  const builtin = new Set(library.listRoleTemplates([]).map(item => item.id));
  for (const id of seen) if (builtin.has(id)) fail('CUSTOM_TEMPLATE_ID_RESERVED');
  return validated.map(item => structuredClone(item));
}

function resolveDutyTemplate(id, library, customs) {
  let resolved;
  try { resolved = library.resolveRoleTemplate(id, customs); }
  catch (error) { fail(/^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'ROLE_TEMPLATE_UNKNOWN'); }
  checkTemplateRecord(resolved);
  if (resolved.id !== id) fail('ROLE_TEMPLATE_UNKNOWN');
  return resolved;
}

/** Apply explicit member edits, removals, seed responsibility and the member
 * cap to the saved raw template. Adds need their full route explicitly; a
 * referenced duty template only supplies non-route defaults, and never
 * rewrites an existing member. A new member generated from a built-in duty
 * template without an explicit tool list adopts the suggestion intersected
 * with the live root catalog — the confirmed list is what preview shows and
 * apply saves. Explicit lists, saved members and custom duty templates stay
 * exact and unfiltered. seedTasks replaces the future team's seed list as an
 * explicit whole (owners reassigned or cleared, tasks added or dropped); member
 * removal still refuses while any seed task owner stays, so nothing is
 * deleted silently. */
function buildTemplate(before, args, library, customs, availableTools) {
  const removals = args.removeMembers ?? [];
  const edits = args.members ?? [];
  if (!Array.isArray(removals) || removals.some(name => typeof name !== 'string')
    || new Set(removals).size !== removals.length
    || removals.some(name => !before.members.some(member => member.name === name))) fail('INVALID_MEMBER_REMOVALS');
  if (args.seedTasks !== undefined && !Array.isArray(args.seedTasks)) fail('INVALID_SEED_TASKS');
  const next = structuredClone(before), removed = new Set(removals);
  if (args.seedTasks !== undefined) next.seed_tasks = structuredClone(args.seedTasks);
  if (removed.size) {
    const owners = new Set(next.seed_tasks.filter(task => own(task, 'owner')).map(task => task.owner));
    for (const name of removed) if (owners.has(name)) fail('SEED_TASK_OWNER_REMOVED');
    next.members = next.members.filter(member => !removed.has(member.name));
  }
  if (!Array.isArray(edits) || edits.length > 16) fail('INVALID_ROLE_EDITS');
  const seen = new Set();
  for (const edit of edits) {
    if (!record(edit) || typeof edit.name !== 'string' || !MEMBER_NAME.test(edit.name) || edit.name === 'lead'
      || seen.has(edit.name) || Object.keys(edit).some(key => key !== 'name' && !FIELDS.includes(key))
      || !FIELDS.some(key => own(edit, key))) fail('INVALID_ROLE_EDITS');
    seen.add(edit.name);
    const existing = next.members.find(member => member.name === edit.name);
    if (existing) {
      for (const key of FIELDS) if (own(edit, key)) existing[key] = edit[key];
      if (own(edit, 'role')) resolveDutyTemplate(edit.role, library, customs);
      continue;
    }
    if (!ROUTE_FIELDS.every(key => own(edit, key))) fail('INVALID_MEMBER_ADDITION');
    const base = own(edit, 'role') ? resolveDutyTemplate(edit.role, library, customs) : null;
    const fromBuiltin = base !== null && library.listRoleTemplates([]).some(row => row.id === edit.role);
    const member = { name: edit.name, agent_preset: `dsh-team-${edit.name}` };
    for (const key of DEFAULTED) {
      if (own(edit, key)) { member[key] = edit[key]; continue; }
      if (base === null) continue;
      member[key] = key === 'native_tool_allowlist' && fromBuiltin
        ? base.native_tool_allowlist.filter(name => availableTools.has(name))
        : base[key];
    }
    for (const key of ROUTE_FIELDS) member[key] = edit[key];
    if (base !== null) member.role = edit.role;
    next.members.push(member);
  }
  // Adds beyond the declared maximum need an explicit cap raise in the same preview.
  const currentCap = next.max_members ?? 4, cap = args.maxMembers ?? currentCap;
  if (!Number.isInteger(cap) || cap < 1 || cap > 8 || cap < next.members.length) fail('TEMPLATE_MEMBER_LIMIT');
  if (cap !== currentCap) next.max_members = cap;
  validateLauncherTemplate(next);
  return next;
}

/** Profile-wide guidance and a root-only editor over the native settings owner. */
export async function applyTeamConfigurator(ctx, launcher, nativeConfiguration, options = {}) {
  const { defineTool, approveEscalation } = nativeConfiguration ?? {};
  if (typeof ctx.settings?.describe !== 'function' || typeof ctx.settings?.update !== 'function'
    || typeof ctx.skills?.register !== 'function' || typeof ctx.sandboxPolicy?.resolve !== 'function'
    || typeof ctx.tools?.definitions !== 'function'
    || typeof defineTool !== 'function' || typeof approveEscalation !== 'function') fail('CONFIGURATION_SERVICES_UNAVAILABLE');
  const library = options.roleTemplates && typeof options.roleTemplates.listRoleTemplates === 'function'
    && typeof options.roleTemplates.resolveRoleTemplate === 'function'
    && typeof options.roleTemplates.validateCustomRoleTemplates === 'function' ? options.roleTemplates : null;
  const defaultCustoms = Array.isArray(options.defaultCustomTemplates) ? options.defaultCustomTemplates : [];
  const requireLibrary = () => { if (library === null) fail('ROLE_TEMPLATES_UNAVAILABLE'); return library; };
  let closing = false;
  ctx.effect(function* () { yield () => { closing = true; }; });

  const snapshot = agent => {
    const row = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === NS);
    if (!row || !Number.isInteger(row.revision)) fail('CONFIGURATION_NAMESPACE_UNAVAILABLE');
    const template = structuredClone(row.value?.template ?? launcher.defaultTemplate(agent));
    validateLauncherTemplate(template);
    const customsRaw = Array.isArray(row.value?.customRoleTemplates) ? row.value.customRoleTemplates : defaultCustoms;
    // Role features stay explicitly unavailable without the pure template library;
    // plain member edits keep working for integrations that wire none.
    const customs = library === null ? [] : normalizeCustoms(structuredClone(customsRaw), library);
    return { revision: row.revision, template, customs };
  };
  const authorization = (agent, template) => {
    const policy = readAuthorizedRoutes(ctx, agent.session);
    return template.members.map(member => ({ name: member.name, provider: member.provider, model: member.model,
      authorized: Array.isArray(policy) && policy.some(route => route.provider === member.provider && route.model === member.model) }));
  };
  const memberProperties = Object.fromEntries(FIELDS.map(key => [key, key === 'native_tool_allowlist'
    ? { type: 'array', items: { type: 'string' }, description: 'Exact tool names from action tools; replaces this member list. An empty array intentionally removes all tools.' }
    : key === 'role' ? { type: 'string', description: 'Optional duty-template id; fills non-route defaults for a newly added member.' }
    : { type: 'string' }]));
  ctx.tools.register(defineTool({
    name: 'dsh_team_configure',
    description: 'Inspect or configure team member defaults for this Harness profile: any 1-8 named members, optional duty templates, per-member model/effort/prompt/tool lists, the future team\'s seed responsibilities and the custom duty-template catalog. Inspect providers and session authorization; list provider models, available tools or duty templates; preview exact edits and apply the same fingerprint and settings revision. Native approval and persistent settings own writes. Tool selection preserves native sandbox/approval and does not grant model authorization, change existing members or bound roots, launch a team or call inference.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'models', 'tools', 'roles', 'preview', 'apply'] },
      provider: { type: 'string', description: 'For models: exact registered provider ID.' },
      members: { type: 'array', description: 'For preview/apply: partial edits by member name. A known name edits that member; a new name adds a member and needs provider, model and reasoning_effort explicitly (a role fills the remaining duty defaults).', items: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string', required: true }, ...memberProperties },
      } },
      removeMembers: { type: 'array', items: { type: 'string' }, description: 'For preview/apply: exact existing member names to remove. A member still owning a seed task cannot be removed; reassign that ownership through seedTasks in the same request.' },
      seedTasks: { type: 'array', description: 'For preview/apply: the full replacement seed-task list for future default teams. Owners may be reassigned or cleared and tasks may be explicitly added or dropped; owners must match the resulting member set.', items: {
        type: 'object', additionalProperties: false, properties: {
          key: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          description: { type: 'string', required: true },
          owner: { type: 'string' },
          blocked_by: { type: 'array', items: { type: 'string' } },
        } } },
      customTemplates: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        description: { type: 'string', required: true },
        persona_prompt: { type: 'string', required: true },
        prompt: { type: 'string', required: true },
        native_tool_allowlist: { type: 'array', items: { type: 'string' }, required: true },
      } }, description: 'For preview/apply: the full replacement custom duty-template list, validated and persisted in the same settings revision.' },
      maxMembers: { type: 'number', description: 'For preview/apply: explicit 1-8 member cap when adding members beyond the template maximum.' },
      expectedRevision: { type: 'number', description: 'For preview/apply: revision returned by inspect.' },
      expectedFingerprint: { type: 'string', description: 'For apply: fingerprint returned by preview for these exact edits.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      let writeAttempted = false;
      try {
        if (closing) fail('UNLOADING');
        exec.signal.throwIfAborted();
        launcher.assertRoot(exec.agent);
        if (!record(args) || !['inspect', 'models', 'tools', 'roles', 'preview', 'apply'].includes(args.action)) fail('INVALID_CONFIGURATION_ACTION');
        if (args.action === 'tools') return JSON.stringify({ ok: true, tools: roleToolCatalog(ctx, exec.agent),
          scope: 'registered shared tools visible to this root and native Team Preset capabilities; native step activation, sandbox and approval still apply', inferenceCalls: 0 });
        if (args.action === 'models') {
          if (typeof args.provider !== 'string' || !ctx.llm.listProviders().some(row => row.id === args.provider)) fail('UNKNOWN_PROVIDER');
          const models = await ctx.llm.listModels(args.provider);
          exec.signal.throwIfAborted();
          if (closing) fail('UNLOADING');
          return JSON.stringify({ ok: true, provider: args.provider,
            models: models.map(model => ({ id: model.id, name: model.name })) });
        }
        const before = snapshot(exec.agent);
        if (args.action === 'inspect') {
          const current = exec.agent.model?.current();
          const catalog = library === null ? null : (() => {
            const builtin = requireLibrary().listRoleTemplates([]);
            const customs = before.customs;
            const merged = [...builtin];
            for (const item of customs) if (!merged.some(row => row.id === item.id)) merged.push(item);
            return merged.map(row => ({ ...row, source: customs.some(item => item.id === row.id) ? 'custom' : 'built-in' }));
          })();
          return JSON.stringify({ ok: true, ...before,
            fingerprint: configureFingerprint(before.template, before.customs),
            roleTemplatesAvailable: library !== null, ...(catalog === null ? {} : { templates: catalog }),
            currentModel: current && { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort },
            providers: ctx.llm.listProviders().map(provider => ({ id: provider.id, name: provider.name })),
            authorizedRoutes: readAuthorizedRoutes(ctx, exec.agent.session) ?? [],
            currentSessionAlreadyBound: launcher.hasBinding(exec.agent.id),
            scope: 'profile defaults for roots not yet bound', existingMembersChanged: false });
        }
        if (args.action === 'roles') {
          requireLibrary();
          const builtin = library.listRoleTemplates([]);
          const merged = [...builtin];
          for (const item of before.customs) if (!merged.some(row => row.id === item.id)) merged.push(item);
          const templates = merged.map(row => ({ ...row, source: before.customs.some(item => item.id === row.id) ? 'custom' : 'built-in' }));
          return JSON.stringify({ ok: true, revision: before.revision, templates,
            scope: 'duty templates supply non-route defaults for new members; they grant no route, tool permission or member changes', inferenceCalls: 0 });
        }
        if (!Number.isInteger(args.expectedRevision) || args.expectedRevision !== before.revision) fail('SETTINGS_CONFLICT');
        const usesDutyTemplates = args.customTemplates !== undefined
          || (Array.isArray(args.members) && args.members.some(edit => own(edit, 'role')));
        if (usesDutyTemplates) requireLibrary();
        if (!(Array.isArray(args.members) && args.members.length) && !(Array.isArray(args.removeMembers) && args.removeMembers.length)
          && args.customTemplates === undefined && args.maxMembers === undefined
          && args.seedTasks === undefined) fail('INVALID_CONFIGURATION_ACTION');
        const customs = args.customTemplates !== undefined
          ? normalizeCustoms(args.customTemplates, requireLibrary()) : before.customs;
        const availableTools = new Set(roleToolCatalog(ctx, exec.agent).map(tool => tool.name));
        const next = buildTemplate(before.template, args, library ?? undefined, customs, availableTools), nextFingerprint = configureFingerprint(next, customs);
        if (args.action === 'apply' && args.expectedFingerprint !== nextFingerprint) fail('CONFIGURATION_PREVIEW_CHANGED');
        const checkTools = () => assertRoleToolsAvailable(ctx, exec.agent, [...next.members.map(member => member.native_tool_allowlist),
          ...(args.customTemplates !== undefined ? customs.map(item => item.native_tool_allowlist) : [])]);
        checkTools();
        const metadataValidated = [];
        for (const member of next.members) {
          const edit = args.members?.find(row => row.name === member.name);
          if (!edit || !ROUTE_FIELDS.some(key => own(edit, key))) continue;
          const route = { provider: member.provider, model: member.model,
            reasoningEffort: member.reasoning_effort, maxTokens: 1024 };
          const resolved = await ctx.llm.resolveCallConfig({ ...route }, exec.signal);
          exec.signal.throwIfAborted();
          if (closing) fail('UNLOADING');
          if (!sameControls(resolved, route)) fail('RESOLVED_CONTROLS_CHANGED');
          metadataValidated.push(member.name);
        }
        if (snapshot(exec.agent).revision !== before.revision) fail('SETTINGS_CONFLICT');
        checkTools();
        const currentSessionAuthorization = authorization(exec.agent, next);
        const needsNewRoot = () => launcher.hasBinding(exec.agent.id) || currentSessionAuthorization.some(row => !row.authorized);
        const result = { ok: true, revision: before.revision, fingerprint: nextFingerprint,
          template: next, customTemplates: customs, metadataValidated,
          currentSessionAuthorization,
          currentSessionNeedsNewRoot: needsNewRoot(),
          existingMembersChanged: false, inferenceCalls: 0 };
        if (args.action === 'preview') return JSON.stringify({ ...result, persisted: false });
        const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
        await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: policy.mode,
          subject: 'team default configuration', justification: 'Save the previewed member/model/effort/prompt/tool-list defaults and custom duty templates in this Harness profile. Native sandbox and tool approvals, existing members and model authorization remain unchanged.' },
        { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'dsh_team_configure', signal: exec.signal });
        exec.signal.throwIfAborted();
        if (closing) fail('UNLOADING');
        if (snapshot(exec.agent).revision !== before.revision) fail('SETTINGS_CONFLICT');
        checkTools();
        writeAttempted = true;
        await ctx.settings.update(NS, { template: next, customRoleTemplates: customs }, before.revision);
        const after = snapshot(exec.agent);
        if (configureFingerprint(after.template, after.customs) !== nextFingerprint) fail('CONFIGURATION_READBACK_CHANGED');
        return JSON.stringify({ ...result, revision: after.revision, persisted: true,
          currentSessionNeedsNewRoot: needsNewRoot() });
      } catch (error) {
        const uncertain = writeAttempted && errorCode(error) !== 'SETTINGS_CONFLICT';
        return JSON.stringify({ ok: false,
          code: uncertain ? 'TEAM_CONFIGURATION_WRITE_UNCONFIRMED' : exec.signal.aborted ? 'CONFIGURATION_CANCELLED' : errorCode(error),
          persistenceUnconfirmed: uncertain, stopFurtherMutation: true, noAutomaticRetry: true });
      }
    },
  }));
  const path = new URL('../skills/dsh-team-configure/SKILL.md', import.meta.url);
  const content = (await readFile(path, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  ctx.skills.register({ name: 'dsh-team-configure', source: 'runtime',
    description: '在会话中配置 DSH 团队：查看本机 provider、模型、工具目录与职责模板，为 1-8 个成员设置模型、effort、提示词和工具集，管理自定义职责模板，预检并保存默认模板。不自动启动成员。',
    invocation: { modelInvocable: true, userInvocable: true },
    path: fileURLToPath(path), resourceBase: { kind: 'directory', path: fileURLToPath(new URL('.', path)) }, content });
}
