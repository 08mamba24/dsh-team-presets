import { isAbsolute } from 'node:path';
import { fail, sameControls } from './config.js';

export const TEAM_ROLES = Object.freeze(['implementer', 'reviewer']);
export const TEAM_STREAM_LIMITS = Object.freeze({ implementer: 6, reviewer: 5 });
export const TEAM_ROLE_TOOLS = Object.freeze([
  'team_task_get', 'team_task_update', 'send_message', 'wait_agent',
]);

const topKeys = ['mode', 'ownedSessionId', 'workspace', 'runTag', 'timeoutMs', 'roles'];
const roleKeys = ['memberName', 'presetId', 'personaNonce', 'route', 'maxStreams'];
const routeKeys = ['provider', 'model', 'reasoningEffort', 'maxTokens'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (x, keys) => record(x) && Object.keys(x).length === keys.length
  && Object.keys(x).every(key => keys.includes(key));
const routeText = x => typeof x === 'string' && x.length > 0 && x.length <= 200 && x.trim() === x;

/** Explicit pair configuration; no inferred route, preset, or request budget. */
export function parseTeamConfig(raw) {
  if (!exactKeys(raw, topKeys) || raw.mode !== 'team'
    || typeof raw.ownedSessionId !== 'string'
    || !/^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.ownedSessionId)
    || typeof raw.workspace !== 'string' || !isAbsolute(raw.workspace)
    || typeof raw.runTag !== 'string' || !/^[a-z][a-z0-9-]{5,63}$/.test(raw.runTag)
    || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 120000
    || !exactKeys(raw.roles, TEAM_ROLES)) fail('INVALID_TEAM_CONFIG');
  const roles = {};
  for (const role of TEAM_ROLES) {
    const value = raw.roles[role];
    if (!exactKeys(value, roleKeys) || typeof value.memberName !== 'string'
      || !/^[a-z][a-z0-9-]{0,31}$/.test(value.memberName)
      || value.memberName === 'lead' || typeof value.presetId !== 'string'
      || !/^dsh-(?:live|team)-[a-z0-9-]+$/.test(value.presetId)
      || typeof value.personaNonce !== 'string' || !/^[a-z0-9-]{12,96}$/.test(value.personaNonce)
      || value.maxStreams !== TEAM_STREAM_LIMITS[role]) fail('INVALID_TEAM_ROLE');
    const r = value.route;
    if (!exactKeys(r, routeKeys) || !routeText(r.provider) || !routeText(r.model)
      || r.reasoningEffort !== 'low' || r.maxTokens !== 1024) fail('INVALID_CONTROLS');
    if (r.provider === 'deepseek-official' && r.model === 'deepseek-v4-pro') fail('KNOWN_MODEL_ALIAS');
    roles[role] = Object.freeze({ ...value, route: Object.freeze({ ...r }) });
  }
  const { implementer, reviewer } = roles;
  if (implementer.memberName === reviewer.memberName || implementer.presetId === reviewer.presetId
    || implementer.personaNonce === reviewer.personaNonce) fail('TEAM_ROLE_IDENTITY_COLLISION');
  // Two providers advertising one model do not meet this phase's distinct-model requirement.
  if (implementer.route.model === reviewer.route.model) fail('DISTINCT_MODELS_REQUIRED');
  return Object.freeze({ ...raw, roles: Object.freeze(roles) });
}

/** Both routes must already belong to the exact native Session policy. */
export function authorizeTeam(config, policy) {
  if (!Array.isArray(policy) || TEAM_ROLES.some(role => !policy.some(route =>
    route?.provider === config.roles[role].route.provider && route.model === config.roles[role].route.model))) {
    fail('SESSION_ROUTE_NOT_AUTHORIZED');
  }
  return true;
}

/** Validate the complete pair before either child activation; metadata is not inference. */
export async function preflightTeam(config, policy, llm, signal) {
  signal.throwIfAborted();
  authorizeTeam(config, policy);
  const result = {};
  for (const role of TEAM_ROLES) {
    const route = config.roles[role].route;
    const resolved = await llm.resolveCallConfig({ ...route }, signal);
    signal.throwIfAborted();
    if (!sameControls(resolved, route)) fail('RESOLVED_CONTROLS_CHANGED');
    result[role] = Object.freeze({ ...route });
  }
  return Object.freeze(result);
}
