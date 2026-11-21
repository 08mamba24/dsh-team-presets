import { fail } from './config.js';
import { types } from 'node:util';

export const COLLABORATION_TOOLS = Object.freeze(['team_task_get', 'team_task_update', 'send_message', 'wait_agent']);
const WORK_TOOLS = Object.freeze(['read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'bash', 'pwsh', 'str_replace_editor', 'skill']);
const MANAGED = new Set(['run_code', 'subagent', 'spawn_agent', 'fork_agent', 'subagent_fork', 'resume_agent',
  'close_agent', 'interrupt_agent', 'list_agents', 'plugin_manager', 'workflow', 'ralph']);
const PRESET_TOOL = Symbol('native control Preset capability');
const PRESET_TOOLS = ['send_message', 'wait_agent'];

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

/** Shared definitions retain their native activation. Unconditional local
 * definitions can be installed verbatim on a separate role scope. */
function roleToolDefinitions(ctx, agent) {
  if (typeof ctx.tools?.definitions !== 'function') fail('TEAM_TOOL_CATALOG_UNAVAILABLE');
  const visible = new Map(ctx.tools.definitions(agent).map(tool => [tool.name, tool]));
  // Control Presets contribute these two names after composition. Task tools
  // and work tools must actually exist in the root-visible registry.
  const result = new Map(PRESET_TOOLS.map(name => [name, PRESET_TOOL]));
  const shared = new Map(ctx.tools.definitions().map(tool => [tool.name, tool]));
  for (const name of PRESET_TOOLS) {
    if (shared.has(name) && !visible.has(name)) result.delete(name);
  }
  for (const tool of visible.values()) {
    if (!selectableRoleTool(tool.name)) continue;
    // A local registration's activation callback is not part of ToolDefinition.
    // The public executable lookup only admits unconditional registrations.
    if (shared.get(tool.name) !== tool && ctx.tools.executable?.(tool.name, agent) !== tool) continue;
    result.set(tool.name, tool);
  }
  return result;
}

export function roleToolCatalog(ctx, agent) {
  return [...roleToolDefinitions(ctx, agent)].map(([name, definition]) => ({ name,
    description: definition === PRESET_TOOL ? `Native team capability: ${name}`
      : typeof definition.description === 'string' ? definition.description : '',
    group: group(name), source: definition === PRESET_TOOL ? 'team-preset' : 'host',
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export function assertRoleToolsAvailable(ctx, agent, lists) {
  const names = new Set(roleToolCatalog(ctx, agent).map(tool => tool.name));
  for (const list of lists) {
    if (!validRoleToolList(list) || list.some(name => !names.has(name))) {
      fail('TEAM_TOOL_UNAVAILABLE');
    }
  }
}

/** Preset generations are independent of the root scope. Retain and recheck
 * exact definitions instead of assuming root restrictions propagate. */
export function captureRoleToolAuthority(ctx, root, lists) {
  assertRoleToolsAvailable(ctx, root, lists);
  const available = roleToolDefinitions(ctx, root);
  const captured = new Map(lists.flat().map(name => [name, available.get(name)]));
  const shared = new Map(ctx.tools.definitions().map(tool => [tool.name, tool]));
  const local = new Set([...captured].filter(([name, definition]) => !PRESET_TOOLS.includes(name)
    && shared.get(name) !== definition).map(([name]) => name));
  const matches = (current, name, definition) => current.has(name) && current.get(name) === definition
    && (!local.has(name) || ctx.tools.executable(name, root) === definition);
  return {
    assertAvailable() {
      const current = roleToolDefinitions(ctx, root);
      for (const [name, definition] of captured) {
        if (!matches(current, name, definition)) fail('TEAM_TOOL_UNAVAILABLE');
      }
    },
    allows(exec) {
      const current = roleToolDefinitions(ctx, root), definition = captured.get(exec.name);
      if (!captured.has(exec.name) || !matches(current, exec.name, definition)) return false;
      // These two definitions are supplied locally by each native control Preset.
      if (PRESET_TOOLS.includes(exec.name)) return true;
      return ctx.tools.definitions(exec.agent, exec.toolSet).some(tool => tool === definition);
    },
  };
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
