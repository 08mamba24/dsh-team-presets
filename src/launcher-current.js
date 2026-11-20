import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { types } from 'node:util';
import { parse } from 'node:path';
import { fail } from './config.js';
import { parseLauncherConfig, validateLauncherTemplate } from './launcher-config.js';
import { applyLauncher } from './launcher-driver.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const codeOf = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'CURRENT_SESSION_SETUP_FAILED';

function options(raw) {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('INVALID_CURRENT_SESSION_CONFIG');
  const allowed = ['mode', 'template', 'timeoutMs', 'maxStreams'];
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail('INVALID_CURRENT_SESSION_CONFIG');
  }
  if (raw.mode !== 'current-session') fail('INVALID_CURRENT_SESSION_CONFIG');
  const timeoutMs = raw.timeoutMs ?? 120000;
  const streams = raw.maxStreams ?? { implementer: 1, reviewer: 1 };
  // Reuse the startup bounds parser; these placeholders are never a runtime binding.
  const bounds = parseLauncherConfig({ mode: 'launcher', ownedSessionId: 'session-00000000-0000-4000-8000-000000000000',
    workspace: parse(process.cwd()).root, runTag: 'current-config', timeoutMs, templateSha256: '0'.repeat(64),
    startup: { maxTokens: 1024, maxStreams: streams } });
  return { timeoutMs, maxStreams: bounds.startup.maxStreams, template: raw.template };
}

function assertRoot(ctx, agent, binding) {
  if (!agent || typeof agent.id !== 'string' || !/^session-[a-f0-9-]{36}$/.test(agent.id)
    || agent.session?.id !== agent.id || ctx.agents.get(agent.id) !== agent
    || agent.session.header?.origin === 'subagent') fail('WRONG_AGENT');
  const workspace = ctx.workingDirectory.get(agent.session);
  if (binding && (agent.id !== binding.ownedSessionId || workspace !== binding.workspace)) {
    fail('CURRENT_SESSION_BINDING_CHANGED');
  }
  return workspace;
}

/** One installed command; every root gets native-owned, independently scoped role Presets. */
export async function applyCurrentLauncher(ctx, raw, nativeSubagent, controlEntry, liveConfig) {
  const config = options(raw);
  if (typeof ctx.plugin !== 'function' || typeof ctx.commands?.register !== 'function'
    || typeof ctx.agents?.get !== 'function' || typeof ctx.effect !== 'function'
    || typeof ctx.workingDirectory?.get !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
  const bundled = JSON.parse(await readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
  const input = config.template ?? bundled;
  validateLauncherTemplate(input);
  const template = structuredClone(input);
  const defaultTemplate = () => {
    const current = liveConfig ? liveConfig.readTemplate() ?? bundled : template;
    validateLauncherTemplate(current);
    return structuredClone(current);
  };
  const instances = new Map();
  let closing = false, busy = false, outstanding = false;

  async function bindingFor(agent) {
    const workspace = assertRoot(ctx, agent);
    const existing = instances.get(agent.id);
    if (existing) {
      assertRoot(ctx, agent, existing.config);
      return existing.ready;
    }
    const suffix = digest(agent.id).slice(0, 24);
    const scoped = defaultTemplate();
    for (const member of scoped.members) member.agent_preset = `dsh-current-${suffix}-${member.name}`;
    const bound = parseLauncherConfig({ mode: 'launcher', ownedSessionId: agent.id, workspace,
      runTag: `current-${suffix}`, timeoutMs: config.timeoutMs, templateSha256: digest(JSON.stringify(scoped)),
      startup: { maxTokens: 1024, maxStreams: config.maxStreams } });
    const instance = { config: bound };
    // Retain a failed setup too: an uncertain registration is never automatically retried.
    instances.set(agent.id, instance);
    instance.ready = (async () => {
      let handler;
      const module = { name: `current-team-${suffix}`, async apply(inner) {
        await applyLauncher(inner, bound, nativeSubagent, controlEntry, {
          template: scoped, assertOwned: caller => assertRoot(ctx, caller, bound),
          capture(value) { handler = value; },
        });
      } };
      instance.fiber = ctx.plugin(module);
      await instance.fiber;
      if (closing) fail('UNLOADING');
      assertRoot(ctx, agent, bound);
      if (typeof handler !== 'function') fail('CURRENT_SESSION_SETUP_FAILED');
      return handler;
    })();
    return instance.ready;
  }

  const unregister = ctx.commands.register({ name: 'dsh-team', description: 'Build the configured team in this session',
    input: { hint: 'plan | launch | restore', attachments: false },
    async handler(request) {
      try {
        if (closing) fail('UNLOADING');
        if (outstanding) fail('OUTSTANDING_LAUNCHER_OPERATION');
        if (busy) fail('BUSY');
        if (!['plan', 'launch', 'restore'].includes(request.rawInput?.trim())
          || !Array.isArray(request.attachments) || request.attachments.length) fail('USAGE_PLAN_LAUNCH_RESTORE_ONLY');
        request.signal.throwIfAborted();
        assertRoot(ctx, request.agent);
        busy = true;
        try {
          const handler = await bindingFor(request.agent);
          if (closing) fail('UNLOADING');
          request.signal.throwIfAborted();
          const result = await handler(request);
          const receipt = JSON.parse(result.text);
          if (receipt.reconciliationRequired || receipt.code?.endsWith('_DRAINING_GUARD_RETAINED')) outstanding = true;
          return result;
        } finally { busy = false; }
      } catch (error) {
        return { kind: 'error', text: JSON.stringify({ code: codeOf(error), stopFurtherMutation: true, noAutomaticRetry: true }) };
      }
    } });
  ctx.effect(function* () {
    yield () => { closing = true; return unregister(); };
  });
  return { defaultTemplate, hasBinding: id => instances.has(id), assertRoot: agent => assertRoot(ctx, agent) };
}
