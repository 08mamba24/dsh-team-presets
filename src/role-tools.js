import { fail } from './config.js';
import { types } from 'node:util';

export const COLLABORATION_TOOLS = Object.freeze(['team_task_get', 'team_task_update', 'send_message', 'wait_agent']);
const WORK_TOOLS = Object.freeze(['read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'bash', 'pwsh', 'str_replace_editor', 'skill']);
const MANAGED = new Set(['run_code', 'subagent', 'spawn_agent', 'fork_agent', 'resume_agent', 'close_agent', 'interrupt_agent', 'list_agents']);

/** Tool names are capabilities, not shell commands or permission grants. */
export function selectableRoleTool(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && name.trim() === name
    && !name.includes('\0') && !MANAGED.has(name) && !name.startsWith('dsh_team_')
    && (!name.startsWith('team_') || COLLABORATION_TOOLS.includes(name));
}

export function validRoleToolList(names) {
  if (!Array.isArray(names) || types.isProxy(names) || Object.getPrototypeOf(names) !== Array.prototype
    || Reflect.ownKeys(names).length !== names.length + 1) return false;
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    const value = Object.getOwnPropertyDescriptor(names, String(i));
    if (!value || !Object.hasOwn(value, 'value') || !selectableRoleTool(value.value) || seen.has(value.value)) return false;
    seen.add(value.value);
  }
  return true;
}

function group(name) {
  if (COLLABORATION_TOOLS.includes(name)) return 'collaboration';
  if (['read', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'read_image'].includes(name)) return 'files';
  if (['glob', 'grep'].includes(name)) return 'search';
  if (['bash', 'pwsh'].includes(name)) return 'shell';
  if (name === 'skill') return 'skills';
  return name.startsWith('mcp_') ? 'mcp' : 'other';
}

/** Shared definitions only: root-local tools cannot be promised to a child Preset. */
export function roleToolCatalog(ctx, agent) {
  if (typeof ctx.tools?.definitions !== 'function') fail('TEAM_TOOL_CATALOG_UNAVAILABLE');
  const visible = new Map(ctx.tools.definitions(agent).map(tool => [tool.name, tool]));
  // Control Presets contribute these two names after composition. Task tools
  // and work tools must actually exist in the shared, root-visible registry.
  const result = new Map(['send_message', 'wait_agent'].map(name => [name,
    { name, description: `Native team capability: ${name}`, group: 'collaboration', source: 'team-preset' }]));
  for (const tool of ctx.tools.definitions()) {
    if (visible.get(tool.name) !== tool) { result.delete(tool.name); continue; }
    if (!selectableRoleTool(tool.name)) continue;
    result.set(tool.name, { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '',
      group: group(tool.name), source: 'host' });
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function assertRoleToolsAvailable(ctx, agent, lists) {
  const names = new Set(roleToolCatalog(ctx, agent).map(tool => tool.name));
  for (const list of lists) {
    if (!validRoleToolList(list) || list.some(name => !names.has(name))) {
      fail('TEAM_TOOL_UNAVAILABLE');
    }
  }
}

/** Only unsaved defaults adapt to installed tools. Saved/explicit lists remain exact. */
export function defaultWorkTemplate(ctx, agent, bundled) {
  const available = new Set(roleToolCatalog(ctx, agent).map(tool => tool.name));
  const template = structuredClone(bundled);
  for (const member of template.members) {
    member.native_tool_allowlist = [...COLLABORATION_TOOLS, ...WORK_TOOLS].filter(name => available.has(name));
  }
  return template;
}
