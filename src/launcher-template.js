import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { selectableRoleTool } from './role-tools.js';

const SCHEMA = 'dsh-team-template/1';
const TOP = ['template_schema', 'template_meta', 'version', 'name', 'max_members', 'members', 'seed_tasks'];
const MEMBER = ['name', 'description', 'prompt', 'persona_prompt', 'agent_preset', 'provider', 'model', 'reasoning_effort', 'native_tool_allowlist', 'role'];
const TASK = ['key', 'subject', 'description', 'owner', 'blocked_by'];
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const own = (value, key) => Object.hasOwn(value, key);

class LauncherTemplateError extends Error {
  constructor(code) { super(code); this.name = 'LauncherTemplateError'; this.code = code; }
}
function fail(code) { throw new LauncherTemplateError(code); }
function fields(value, allowed, code) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !own(descriptor, 'value')) fail(code);
  }
}
function array(value, code) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail(code);
  }
  return value;
}
function text(value, max, code, blank = false) {
  if (typeof value !== 'string' || [...value].length > max || (!blank && value.trim().length === 0)) fail(code);
  return value;
}
function name(value, code) {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'lead') fail(code);
  return value;
}
function optional(value, source, sourceKey, targetKey, read) {
  if (own(source, sourceKey)) value[targetKey] = read(source[sourceKey]);
}

function member(raw, names, presets) {
  fields(raw, MEMBER, 'INVALID_MEMBER_FIELDS');
  const value = {
    name: name(raw.name, 'INVALID_MEMBER_NAME'),
    description: text(raw.description, 200, 'INVALID_MEMBER_DESCRIPTION'),
    prompt: text(raw.prompt, 8000, 'INVALID_MEMBER_PROMPT'),
  };
  if (names.has(value.name)) fail('DUPLICATE_MEMBER_NAME');
  names.add(value.name);
  // The published schema permits omitting both fields; this execution-preparation parser
  // requires an explicit pair and never chooses a parent or global default for the caller.
  if (!own(raw, 'provider') || !own(raw, 'model')) fail('EXPLICIT_MEMBER_ROUTE_REQUIRED');
  for (const key of ['provider', 'model']) {
    value[key] = text(raw[key], 200, 'INVALID_MEMBER_ROUTE');
    if (value[key].trim() !== value[key]) fail('INVALID_MEMBER_ROUTE');
  }
  optional(value, raw, 'reasoning_effort', 'reasoningEffort', effort => {
    // Effort ids belong to the configured adapter; native preflight validates support.
    text(effort, 200, 'INVALID_MEMBER_EFFORT');
    if (effort.trim() !== effort) fail('INVALID_MEMBER_EFFORT');
    return effort;
  });
  optional(value, raw, 'persona_prompt', 'personaPrompt', persona => text(persona, 8000, 'INVALID_MEMBER_PERSONA'));
  // A role names a duty template id; this parser checks shape only, resolution
  // belongs to the configurator that knows the built-in and custom catalog.
  optional(value, raw, 'role', 'role', role => {
    if (typeof role !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(role)) fail('INVALID_MEMBER_ROLE');
    return role;
  });
  optional(value, raw, 'agent_preset', 'agentPreset', preset => {
    text(preset, 200, 'INVALID_MEMBER_PRESET');
    if (preset.trim() !== preset) fail('INVALID_MEMBER_PRESET');
    if (presets.has(preset)) fail('DUPLICATE_MEMBER_PRESET');
    presets.add(preset); return preset;
  });
  optional(value, raw, 'native_tool_allowlist', 'nativeToolAllowlist', allowlist => {
    const list = array(allowlist, 'INVALID_MEMBER_TOOL_ALLOWLIST');
    if (list.some(tool => !selectableRoleTool(tool))) fail('UNSUPPORTED_MEMBER_TOOL');
    if (new Set(list).size !== list.length) fail('DUPLICATE_MEMBER_TOOL');
    return Object.freeze([...list].sort());
  });
  return Object.freeze(value);
}

function tasks(raw, memberNames) {
  const keys = new Set();
  const values = array(raw, 'INVALID_SEED_TASKS').map(task => {
    fields(task, TASK, 'INVALID_TASK_FIELDS');
    const value = {
      key: name(task.key, 'INVALID_TASK_KEY'),
      subject: text(task.subject, 200, 'INVALID_TASK_TEXT'),
      description: text(task.description, 8000, 'INVALID_TASK_TEXT'),
    };
    if (keys.has(value.key)) fail('DUPLICATE_TASK_KEY');
    keys.add(value.key);
    optional(value, task, 'owner', 'owner', owner => {
      if (typeof owner !== 'string' || !memberNames.has(owner)) fail('INVALID_TASK_OWNER');
      return owner;
    });
    const blockers = own(task, 'blocked_by') ? array(task.blocked_by, 'INVALID_TASK_DEPENDENCIES') : [];
    if (blockers.some(key => typeof key !== 'string')) fail('INVALID_TASK_DEPENDENCIES');
    if (new Set(blockers).size !== blockers.length) fail('DUPLICATE_TASK_DEPENDENCY');
    value.blockedBy = Object.freeze([...blockers].sort());
    return Object.freeze(value);
  });
  const indegrees = new Map(values.map(task => [task.key, task.blockedBy.length]));
  const dependents = new Map(values.map(task => [task.key, []]));
  for (const task of values) for (const blocker of task.blockedBy) {
    if (blocker === task.key) fail('SELF_TASK_DEPENDENCY');
    if (!keys.has(blocker)) fail('UNKNOWN_TASK_DEPENDENCY');
    dependents.get(blocker).push(task.key);
  }
  const ready = values.filter(task => indegrees.get(task.key) === 0).map(task => task.key);
  // Iterative traversal also handles long valid chains without recursive-stack failure.
  for (let i = 0; i < ready.length; i++) for (const next of dependents.get(ready[i])) {
    const remaining = indegrees.get(next) - 1; indegrees.set(next, remaining);
    if (remaining === 0) ready.push(next);
  }
  if (ready.length !== values.length) fail('TASK_DEPENDENCY_CYCLE');
  // Declaration order remains part of the template's identity; dependency order is a launch concern.
  return Object.freeze(values);
}

/** Validate configuration data only; this grants no policy, capability, call budget or live acceptance. */
export function parseLauncherTemplate(raw) {
  fields(raw, TOP, 'INVALID_TEMPLATE_FIELDS');
  if (raw.template_schema !== SCHEMA) fail('INVALID_TEMPLATE_SCHEMA');
  if (raw.version !== 1) fail('INVALID_TEMPLATE_VERSION');
  const templateName = name(raw.name, 'INVALID_TEMPLATE_NAME');
  const maxMembers = own(raw, 'max_members') ? raw.max_members : 4;
  if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 8) fail('INVALID_MAX_MEMBERS');
  const rows = array(raw.members, 'INVALID_TEMPLATE_MEMBERS');
  if (rows.length < 1 || rows.length > 8 || rows.length > maxMembers) fail('INVALID_TEMPLATE_MEMBERS');
  const meta = { liveVerified: false };
  if (own(raw, 'template_meta')) {
    fields(raw.template_meta, ['live_verified', 'notes'], 'INVALID_TEMPLATE_META');
    if (own(raw.template_meta, 'live_verified') && raw.template_meta.live_verified !== false) fail('INVALID_TEMPLATE_META');
    optional(meta, raw.template_meta, 'notes', 'notes', notes => text(notes, 2000, 'INVALID_TEMPLATE_META', true));
  }
  const memberNames = new Set(), presetIds = new Set();
  const members = Object.freeze(rows.map(row => member(row, memberNames, presetIds)));
  return Object.freeze({ templateSchema: SCHEMA, templateMeta: Object.freeze(meta), version: 1,
    name: templateName, maxMembers, members,
    seedTasks: tasks(own(raw, 'seed_tasks') ? raw.seed_tasks : [], memberNames) });
}

const TOP_MAP = { templateSchema: 'template_schema', templateMeta: 'template_meta', version: 'version',
  name: 'name', maxMembers: 'max_members', members: 'members', seedTasks: 'seed_tasks' };
const MEMBER_MAP = { name: 'name', description: 'description', prompt: 'prompt', personaPrompt: 'persona_prompt',
  agentPreset: 'agent_preset', provider: 'provider', model: 'model', reasoningEffort: 'reasoning_effort', nativeToolAllowlist: 'native_tool_allowlist', role: 'role' };
const TASK_MAP = { key: 'key', subject: 'subject', description: 'description', owner: 'owner', blockedBy: 'blocked_by' };
function rename(value, map) {
  fields(value, Object.keys(map), 'INVALID_NORMALIZED_TEMPLATE');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [map[key], item]));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Identity of normalized template content only, never proof of a member's applied persona or route. */
export function launcherTemplateFingerprint(normalized) {
  const raw = rename(normalized, TOP_MAP);
  if (own(raw, 'template_meta')) raw.template_meta = rename(raw.template_meta, { liveVerified: 'live_verified', notes: 'notes' });
  raw.members = array(raw.members, 'INVALID_NORMALIZED_TEMPLATE').map(value => rename(value, MEMBER_MAP));
  if (own(raw, 'seed_tasks')) raw.seed_tasks = array(raw.seed_tasks, 'INVALID_NORMALIZED_TEMPLATE').map(value => rename(value, TASK_MAP));
  const validated = parseLauncherTemplate(raw);
  return createHash('sha256').update(`${SCHEMA}\0${canonical(validated)}`, 'utf8').digest('hex');
}
