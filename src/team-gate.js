import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, sameControls } from './config.js';
import { TEAM_ROLES, TEAM_ROLE_TOOLS } from './team-config.js';
import { validRoleToolList } from './role-tools.js';

const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const copy = value => value === undefined ? undefined : structuredClone(value);

function snapshotRoleTools(options) {
  const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (options !== undefined && (!exact(options, ['roleTools']) || !exact(options.roleTools, TEAM_ROLES))) {
    fail('INVALID_TEAM_GATE_OPTIONS');
  }
  return Object.freeze(Object.fromEntries(TEAM_ROLES.map(role => {
    const input = options === undefined ? TEAM_ROLE_TOOLS : options.roleTools[role];
    if (!Array.isArray(input)) fail('INVALID_TEAM_GATE_OPTIONS');
    const selected = [...input];
    if (!validRoleToolList(selected)) fail('INVALID_TEAM_GATE_OPTIONS');
    return [role, Object.freeze(selected)];
  })));
}

/** Bounded normal tool steps for two lifecycle-correlated children; root inference stays quarantined. */
export function createTeamGate(config, options) {
  // Omission preserves the accepted M2 tool set; a launcher supplies exact role capabilities.
  // Installation lifetime is still owned by the caller, not by these tool-mask options.
  const roleTools = snapshotRoleTools(options);
  const causal = new AsyncLocalStorage(), blocked = new Set(), byChild = new Map();
  const states = Object.fromEntries(TEAM_ROLES.map(role => [role,
    { admissions: 0, streams: [], denials: [], seenResults: new Set(), inFlight: false }]));
  const denials = [];
  let failure, closed = false, closeReason;
  function reject(code, options = {}, role) {
    const entry = { code, sessionId: options.sessionId ?? null, purpose: options.purpose ?? null };
    denials.push(entry);
    if (role) { states[role].denials.push(entry); states[role].failure ??= code; }
    if (code !== 'ROOT_QUARANTINED') failure ??= code;
    fail(code);
  }
  function snapshot(role) {
    const { seenResults, inFlight, ...state } = states[role];
    return { ...copy(state), closed, closeReason };
  }
  return Object.freeze({
    run: operation => causal.run(true, operation),
    inRun: () => causal.getStore() === true,
    blockChild: id => { blocked.add(id); },
    close(reason = 'CLOSED') {
      if (closed) return;
      closed = true;
      closeReason = typeof reason === 'string' && reason.length > 0 ? reason : 'CLOSED';
    },
    track(role, id) {
      if (closed) fail('TEAM_GATE_CLOSED');
      if (!TEAM_ROLES.includes(role) || typeof id !== 'string' || !id || id === config.ownedSessionId
        || states[role].childId !== undefined || byChild.has(id) || blocked.has(id)) fail('UNEXPECTED_CHILD');
      states[role].childId = id;
      byChild.set(id, role);
    },
    evidence: role => role === undefined
      ? { roles: Object.fromEntries(TEAM_ROLES.map(key => [key, snapshot(key)])), failure, denials: copy(denials), closed, closeReason }
      : TEAM_ROLES.includes(role) ? snapshot(role) : fail('INVALID_TEAM_ROLE'),
    async *hook(options, next) {
      if (options.sessionId === config.ownedSessionId) reject('ROOT_QUARANTINED', options);
      if (blocked.has(options.sessionId)) reject('UNEXPECTED_CHILD', options);
      const role = byChild.get(options.sessionId);
      if (role === undefined) {
        if (causal.getStore() === true) reject('UNATTRIBUTED_OWNED_REQUEST', options);
        yield* next(); return;
      }
      const state = states[role], expected = config.roles[role];
      if (closed) reject('TEAM_GATE_CLOSED', options, role);
      if (failure) reject('TEAM_GATE_FAILED', options, role);
      if (options.purpose !== undefined) reject('AUXILIARY_DISABLED', options, role);
      if (!sameControls(options, expected.route)) reject('DISPATCH_CONTROLS_CHANGED', options, role);
      if (state.inFlight) reject('CONCURRENT_OWNED_STREAM', options, role);
      if (state.admissions >= expected.maxStreams) reject('REQUEST_ALLOWANCE_USED', options, role);
      const names = Array.isArray(options.tools) ? options.tools.map(tool => tool?.name) : [];
      if (names.length !== roleTools[role].length || new Set(names).size !== names.length
        || roleTools[role].some(name => !names.includes(name))) reject('TEAM_ROLE_TOOLS_CHANGED', options, role);
      if (!Array.isArray(options.messages)) reject('TEAM_REQUEST_HISTORY_MISSING', options, role);
      const results = options.messages.filter(message => message.role === 'tool');
      if (results.some(message => typeof message.id !== 'string' || !message.id
        || message.source?.kind !== 'tool' || typeof message.toolCallId !== 'string' || !message.toolCallId
        || message.source.callId !== message.toolCallId
        || (message.isError !== undefined && typeof message.isError !== 'boolean'))) reject('TEAM_TOOL_RESULT_INVALID', options, role);
      const fresh = results.filter(message => !state.seenResults.has(message.id));
      if (fresh.some(message => message.isError === true)) reject('TEAM_TOOL_FAILED', options, role);
      if (state.admissions !== 0 && fresh.length === 0) reject('OWNED_STREAM_RETRY_DISABLED', options, role);
      fresh.forEach(message => state.seenResults.add(message.id));
      state.toolNames = [...names];
      state.requiredToolsPresent = true;
      const stream = { index: ++state.admissions, toolResultIds: fresh.map(message => message.id), completed: false };
      state.streams.push(stream);
      state.inFlight = true;
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') {
            if (!chunk.usage || typeof chunk.usage !== 'object' || Array.isArray(chunk.usage)
              || !Number.isSafeInteger(chunk.usage.inputTokens) || !Number.isSafeInteger(chunk.usage.outputTokens)
              || usageKeys.some(key => chunk.usage[key] !== undefined
              && (!Number.isSafeInteger(chunk.usage[key]) || chunk.usage[key] < 0))) reject('MODEL_USAGE_INVALID', options, role);
            stream.usage = copy(chunk.usage);
          }
          if (chunk.type === 'finish') { stream.finish = copy(chunk.reason); state.finish = copy(chunk.reason); }
          yield chunk;
        }
        stream.completed = true;
      } catch (error) {
        state.failure ??= 'OWNED_STREAM_FAILED';
        failure ??= state.failure;
        throw error;
      } finally {
        state.inFlight = false;
        if (stream.usage) {
          state.usage ??= {};
          for (const key of usageKeys) {
            if (stream.usage[key] !== undefined) state.usage[key] = (state.usage[key] ?? 0) + stream.usage[key];
          }
        }
        if (!stream.completed || !stream.usage || !stream.finish) {
          state.failure ??= !stream.completed ? 'OWNED_STREAM_INCOMPLETE' : 'MODEL_EVIDENCE_INCOMPLETE';
          failure ??= state.failure;
        }
      }
    },
  });
}
