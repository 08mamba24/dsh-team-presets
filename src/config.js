import { isAbsolute } from 'node:path';

export class LiveError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new LiveError(code); };
const fields = ['ownedSessionId', 'workspace', 'runTag', 'memberName', 'presetId', 'personaNonce', 'timeoutMs', 'route'];
export function parseConfig(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(k => !fields.includes(k)) || fields.some(k => raw[k] === undefined)) fail('INVALID_CONFIG');
  if (!/^session-[a-f0-9-]{36}$/.test(raw.ownedSessionId) || typeof raw.workspace !== 'string' || !isAbsolute(raw.workspace)
    || !/^[a-z][a-z0-9-]{5,63}$/.test(raw.runTag) || !/^[a-z][a-z0-9-]{0,31}$/.test(raw.memberName)
    || raw.memberName === 'lead' || !/^dsh-live-[a-z0-9-]+$/.test(raw.presetId)
    || !/^[a-z0-9-]{12,96}$/.test(raw.personaNonce) || !Number.isInteger(raw.timeoutMs)
    || raw.timeoutMs < 1 || raw.timeoutMs > 120000) fail('INVALID_CONFIG');
  const r = raw.route;
  if (!r || Object.keys(r).sort().join(',') !== 'maxTokens,model,provider,reasoningEffort'
    || typeof r.provider !== 'string' || !r.provider.trim() || typeof r.model !== 'string' || !r.model.trim()
    || r.reasoningEffort !== 'low' || r.maxTokens !== 1024) fail('INVALID_CONTROLS');
  return Object.freeze({ ...raw, route: Object.freeze({ ...r }) });
}
export function authorize(c, policy) {
  if (!Array.isArray(policy) || !policy.some(r => r?.provider === c.route.provider && r.model === c.route.model)) fail('SESSION_ROUTE_NOT_AUTHORIZED');
  return true;
}
export function sameControls(a, b) {
  return ['provider', 'model', 'reasoningEffort', 'maxTokens'].every(k => a?.[k] === b[k]);
}
export async function preflight(c, policy, llm, signal) {
  signal.throwIfAborted(); authorize(c, policy);
  const resolved = await llm.resolveCallConfig({ ...c.route }, signal);
  signal.throwIfAborted();
  if (!sameControls(resolved, c.route)) fail('RESOLVED_CONTROLS_CHANGED');
  return Object.freeze({ ...c.route });
}
