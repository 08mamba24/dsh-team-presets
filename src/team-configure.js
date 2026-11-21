import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fail, sameControls } from './config.js';
import { validateLauncherTemplate } from './launcher-config.js';
import { launcherTemplateFingerprint } from './launcher-template.js';
import { assertRoleToolsAvailable, roleToolCatalog } from './role-tools.js';

const NS = 'dsh-native-current-team';
const ROLES = ['implementer', 'reviewer'];
const FIELDS = ['provider', 'model', 'reasoning_effort', 'description', 'persona_prompt', 'prompt', 'native_tool_allowlist'];
const ROUTE_FIELDS = ['provider', 'model', 'reasoning_effort'];
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = raw => launcherTemplateFingerprint(validateLauncherTemplate(raw));
const errorCode = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'TEAM_CONFIGURATION_FAILED';

function editTemplate(base, edits) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 2) fail('INVALID_ROLE_EDITS');
  const next = structuredClone(base), seen = new Set();
  for (const edit of edits) {
    if (!record(edit) || !ROLES.includes(edit.name) || seen.has(edit.name)
      || Object.keys(edit).some(key => key !== 'name' && !FIELDS.includes(key))
      || !FIELDS.some(key => own(edit, key))) fail('INVALID_ROLE_EDITS');
    seen.add(edit.name);
    const member = next.members.find(row => row.name === edit.name);
    for (const key of FIELDS) if (own(edit, key)) member[key] = edit[key];
  }
  validateLauncherTemplate(next);
  return next;
}

/** Profile-wide guidance and a root-only editor over the native settings owner. */
export async function applyTeamConfigurator(ctx, launcher, { defineTool, approveEscalation }) {
  if (typeof ctx.settings?.describe !== 'function' || typeof ctx.settings?.update !== 'function'
    || typeof ctx.skills?.register !== 'function' || typeof ctx.sandboxPolicy?.resolve !== 'function'
    || typeof ctx.tools?.definitions !== 'function'
    || typeof defineTool !== 'function' || typeof approveEscalation !== 'function') fail('CONFIGURATION_SERVICES_UNAVAILABLE');
  let closing = false;
  ctx.effect(function* () { yield () => { closing = true; }; });

  const snapshot = agent => {
    const row = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === NS);
    if (!row || !Number.isInteger(row.revision)) fail('CONFIGURATION_NAMESPACE_UNAVAILABLE');
    const template = structuredClone(row.value?.template ?? launcher.defaultTemplate(agent));
    validateLauncherTemplate(template);
    return { revision: row.revision, template };
  };
  const authorization = (agent, template) => {
    const policy = ctx.sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy');
    return template.members.map(member => ({ name: member.name, provider: member.provider, model: member.model,
      authorized: Array.isArray(policy) && policy.some(route => route.provider === member.provider && route.model === member.model) }));
  };
  const memberProperties = Object.fromEntries(FIELDS.map(key => [key, key === 'native_tool_allowlist'
    ? { type: 'array', items: { type: 'string' }, description: 'Exact tool names from action tools; replaces this role list. An empty array intentionally removes all tools.' }
    : { type: 'string' }]));
  ctx.tools.register(defineTool({
    name: 'dsh_team_configure',
    description: 'Inspect or configure implementer/reviewer defaults for this Harness profile. Inspect providers and session authorization; list provider models or available role tools; preview exact role/model/effort/prompt/tool-list edits and apply the same fingerprint and settings revision. Native approval and persistent settings own writes. Tool selection preserves native sandbox/approval and does not grant model authorization, change existing members, launch a team or call inference.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'models', 'tools', 'preview', 'apply'] },
      provider: { type: 'string', description: 'For models: exact registered provider ID.' },
      members: { type: 'array', description: 'For preview/apply: partial edits for the two stable role IDs.', items: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string', required: true, enum: ROLES }, ...memberProperties },
      } },
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
        if (!record(args) || !['inspect', 'models', 'tools', 'preview', 'apply'].includes(args.action)) fail('INVALID_CONFIGURATION_ACTION');
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
          return JSON.stringify({ ok: true, ...before,
            fingerprint: fingerprint(before.template),
            currentModel: current && { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort },
            providers: ctx.llm.listProviders().map(provider => ({ id: provider.id, name: provider.name })),
            authorizedRoutes: ctx.sessionProjections.stateOf(exec.agent.session, 'subagentModelSelectionPolicy') ?? [],
            currentSessionAlreadyBound: launcher.hasBinding(exec.agent.id),
            scope: 'profile defaults for roots not yet bound', existingMembersChanged: false });
        }
        if (!Number.isInteger(args.expectedRevision) || args.expectedRevision !== before.revision) fail('SETTINGS_CONFLICT');
        const next = editTemplate(before.template, args.members), nextFingerprint = fingerprint(next);
        if (args.action === 'apply' && args.expectedFingerprint !== nextFingerprint) fail('CONFIGURATION_PREVIEW_CHANGED');
        const checkTools = () => assertRoleToolsAvailable(ctx, exec.agent, next.members.map(member => member.native_tool_allowlist));
        checkTools();
        const metadataValidated = [];
        for (const member of next.members) {
          const edit = args.members.find(row => row.name === member.name);
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
          template: next, metadataValidated,
          currentSessionAuthorization,
          currentSessionNeedsNewRoot: needsNewRoot(),
          existingMembersChanged: false, inferenceCalls: 0 };
        if (args.action === 'preview') return JSON.stringify({ ...result, persisted: false });
        const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
        await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: policy.mode,
          subject: 'team default configuration', justification: 'Save the previewed role/model/effort/prompt/tool-list defaults in this Harness profile. Native sandbox and tool approvals, existing members and model authorization remain unchanged.' },
        { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'dsh_team_configure', signal: exec.signal });
        exec.signal.throwIfAborted();
        if (closing) fail('UNLOADING');
        if (snapshot(exec.agent).revision !== before.revision) fail('SETTINGS_CONFLICT');
        checkTools();
        writeAttempted = true;
        await ctx.settings.update(NS, { template: next }, before.revision);
        const after = snapshot(exec.agent);
        if (fingerprint(after.template) !== nextFingerprint) fail('CONFIGURATION_READBACK_CHANGED');
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
    description: '在会话中配置 DSH 团队：查看本机 provider、模型与工具目录，为实现/复核角色设置模型、effort、提示词和工具集，预检并保存默认模板。不自动启动成员。',
    invocation: { modelInvocable: true, userInvocable: true },
    path: fileURLToPath(path), resourceBase: { kind: 'directory', path: fileURLToPath(new URL('.', path)) }, content });
}
