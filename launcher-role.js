import { validRoleToolList } from './src/role-tools.js';

const CONFIG_KEYS = ['ownedSessionId', 'roleName', 'personaPrompt', 'tools'];

export const name = 'dsh-launcher-role';
export const inject = ['systemPrompt', 'tools'];

class LauncherRoleError extends Error {
  constructor(code) { super(code); this.name = 'LauncherRoleError'; this.code = code; }
}
const fail = code => { throw new LauncherRoleError(code); };

function parseConfig(raw) {
  let fields;
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('LAUNCHER_ROLE_INVALID_CONFIG');
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== CONFIG_KEYS.length || keys.some(key => !CONFIG_KEYS.includes(key))) fail('LAUNCHER_ROLE_INVALID_CONFIG');
    fields = Object.getOwnPropertyDescriptors(raw);
    if (CONFIG_KEYS.some(key => !Object.hasOwn(fields[key], 'value'))) fail('LAUNCHER_ROLE_INVALID_CONFIG');
  } catch { fail('LAUNCHER_ROLE_INVALID_CONFIG'); }
  const ownedSessionId = fields.ownedSessionId.value, roleName = fields.roleName.value;
  const personaPrompt = fields.personaPrompt.value, inputTools = fields.tools.value;
  if (typeof ownedSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ownedSessionId)) fail('LAUNCHER_ROLE_INVALID_OWNER');
  if (typeof roleName !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(roleName) || roleName === 'lead') fail('LAUNCHER_ROLE_INVALID_NAME');
  if (typeof personaPrompt !== 'string' || personaPrompt.length > 16384 || !personaPrompt.trim() || personaPrompt.includes('\0')) fail('LAUNCHER_ROLE_INVALID_PERSONA');
  if (!validRoleToolList(inputTools)) fail('LAUNCHER_ROLE_INVALID_TOOLS');
  const tools = [];
  try {
    for (let index = 0; index < inputTools.length; index++) {
      const tool = inputTools[index];
      if (tools.includes(tool)) fail('LAUNCHER_ROLE_INVALID_TOOLS');
      tools.push(tool);
    }
  } catch { fail('LAUNCHER_ROLE_INVALID_TOOLS'); }
  return Object.freeze({ ownedSessionId, roleName, personaPrompt, tools: Object.freeze(tools) });
}

/** Preset contributions only. This module creates no member-state or persona-observation proof. */
export async function apply(ctx, raw) {
  const config = parseConfig(raw);
  if (typeof ctx?.systemPrompt?.section !== 'function' || typeof ctx?.on !== 'function') fail('LAUNCHER_ROLE_HOST_UNAVAILABLE');
  ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: config.personaPrompt, interpolate: false });
  ctx.on('agent/created', payload => {
    const agent = payload?.agent;
    if (agent?.session?.header?.origin !== 'subagent') fail('LAUNCHER_ROLE_WRONG_ORIGIN');
    if (agent.session.header.parentSession !== config.ownedSessionId) fail('LAUNCHER_ROLE_WRONG_PARENT');
    if (typeof agent.ctx?.tools?.restrict !== 'function') fail('LAUNCHER_ROLE_TOOLS_UNAVAILABLE');
    try { agent.ctx.tools.restrict({ allow: [...config.tools] }); }
    catch { fail('LAUNCHER_ROLE_TOOLS_UNAVAILABLE'); }
  });
}
