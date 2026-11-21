import { mountLogicalNativeControl } from './src/team-addressing.js';
import { nativeRoleControlFromHost } from './src/team-host.js';
import { REPLACEMENT_OWNER, ROOT_SESSION_ID } from './src/replacement-store.js';

export const name = 'dsh-team-role-control';
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'settings'];

class RoleControlError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RoleControlError';
    this.code = code;
  }
}

const fail = code => { throw new RoleControlError(code); };
let nativeHost;

function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Reflect.ownKeys(raw).length !== 2
    || !Object.hasOwn(raw, 'ownedSessionId') || !Object.hasOwn(raw, 'replacementOwner')
    || typeof raw.ownedSessionId !== 'string' || !ROOT_SESSION_ID.test(raw.ownedSessionId)
    || raw.replacementOwner !== REPLACEMENT_OWNER) fail('TEAM_ADDRESS_CONFIG_INVALID');
  return { ownedSessionId: raw.ownedSessionId };
}

/** Preset-scoped native control with stable logical role addressing. */
export async function apply(ctx, raw) {
  const config = parseConfig(raw);
  nativeHost ??= nativeRoleControlFromHost();
  const host = await nativeHost;
  await mountLogicalNativeControl(ctx, { fixedRootId: config.ownedSessionId, interrupt: false }, host);
}
