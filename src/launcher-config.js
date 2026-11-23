import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import { types } from 'node:util';
import { LiveError, fail } from './config.js';
import { parseLauncherTemplate } from './launcher-template.js';
import { assertWorkingDirectory } from './owned.js';

const FIELDS = ['mode', 'ownedSessionId', 'workspace', 'runTag', 'timeoutMs', 'templateSha256', 'startup'];
const MEMBER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const own = (value, key) => Object.hasOwn(value, key);

function record(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, keys) {
  if (!record(value) || Reflect.ownKeys(value).length !== keys.length) return false;
  return Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && keys.includes(key) && property.enumerable && own(property, 'value');
  });
}
function canonicalPath(path) {
  return typeof path === 'string' && isAbsolute(path) && normalize(path) === path
    && !path.split('/').includes('..');
}

/** Per-member startup stream bounds keyed by stable member name; an omitted member defaults to one. */
function streamBounds(value) {
  if (!record(value) || Reflect.ownKeys(value).length > 8) return false;
  return Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && MEMBER_NAME.test(key) && key !== 'lead' && property.enumerable
      && own(property, 'value') && Number.isInteger(property.value) && property.value >= 1 && property.value <= 12;
  });
}

/** Startup stream bound for one member; native policy still owns route admission. */
export function memberStreams(config, name) {
  return Object.hasOwn(config.startup.maxStreams, name) ? config.startup.maxStreams[name] : 1;
}

/** Preflight configuration only; neither template data nor these bounds grant native authorization. */
export function parseLauncherConfig(raw) {
  if (exact(raw, [])) return null;
  if (!exact(raw, FIELDS) || raw.mode !== 'launcher'
    || typeof raw.ownedSessionId !== 'string'
    || !/^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.ownedSessionId)
    || !canonicalPath(raw.workspace)
    || typeof raw.runTag !== 'string' || !/^[a-z][a-z0-9-]{5,63}$/.test(raw.runTag)
    || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 120000
    || typeof raw.templateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.templateSha256)
    || !exact(raw.startup, ['maxTokens', 'maxStreams']) || raw.startup.maxTokens !== 1024
    || !streamBounds(raw.startup.maxStreams)) fail('INVALID_LAUNCHER_CONFIG');
  return Object.freeze({ ...raw, startup: Object.freeze({ maxTokens: 1024,
    maxStreams: Object.freeze({ ...raw.startup.maxStreams }) }) });
}

function configured(raw) {
  const config = parseLauncherConfig(raw);
  if (!config) fail('INVALID_LAUNCHER_CONFIG');
  return config;
}
function safeFile(stat, maxSize) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o600 && stat.size >= 0 && stat.size <= maxSize;
}
function sameFile(a, b) {
  return ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
}
async function canonicalWorkspace(config) {
  try {
    if (await realpath(config.workspace) !== config.workspace) fail('LAUNCHER_WORKSPACE_NOT_CANONICAL');
  } catch (error) {
    if (error instanceof LiveError) throw error;
    fail('LAUNCHER_WORKSPACE_UNAVAILABLE');
  }
}

/** Read just the fixed owned file, with bounded memory and no final-symlink following. */
async function ownedBytes(config, basename, maxSize, code) {
  if (process.platform === 'win32') fail('LEGACY_BOUND_ENTRY_REQUIRES_MACOS');
  await canonicalWorkspace(config);
  let file;
  try {
    const path = join(config.workspace, basename), before = await lstat(path);
    if (!safeFile(before, maxSize)) fail(code);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await file.stat();
    if (!safeFile(opened, maxSize) || !sameFile(before, opened)) fail(code);
    const buffer = Buffer.alloc(maxSize + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat(), current = await lstat(path);
    if (length > maxSize || length !== opened.size || !safeFile(after, maxSize) || !safeFile(current, maxSize)
      || !sameFile(opened, after) || !sameFile(opened, current)) fail(code);
    await canonicalWorkspace(config);
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof LiveError) throw error;
    fail(code);
  } finally {
    if (file) {
      try { await file.close(); }
      catch { fail(code); }
    }
  }
}

/** Load the exact bound template; policy and resolver checks still belong to native launch admission. */
export async function readLauncherTemplate(rawConfig) {
  const config = configured(rawConfig);
  const bytes = await ownedBytes(config, '.dsh-team-template.json', 65536, 'INVALID_LAUNCHER_TEMPLATE_FILE');
  if (createHash('sha256').update(bytes).digest('hex') !== config.templateSha256) fail('LAUNCHER_TEMPLATE_SHA_MISMATCH');
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); }
  catch { fail('INVALID_LAUNCHER_TEMPLATE_JSON'); }
  return validateLauncherTemplate(raw);
}

/** Launcher entries require every member (1-8, stable unique names) to be fully configured;
 * native policy and metadata own route admission. */
export function validateLauncherTemplate(raw) {
  const template = parseLauncherTemplate(raw);
  for (const member of template.members) {
    if (!own(member, 'personaPrompt') || !own(member, 'agentPreset') || !own(member, 'nativeToolAllowlist')
      || !own(member, 'reasoningEffort')) fail('LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE');
  }
  return template;
}

/** Verify exact live root and existing ownership marker; never create a marker or append policy. */
export async function assertLauncherOwned(ctx, rawConfig, agent) {
  const config = configured(rawConfig);
  if (!agent || agent.id !== config.ownedSessionId || agent.session?.id !== agent.id
    || typeof ctx?.agents?.get !== 'function' || ctx.agents.get(agent.id) !== agent
    || agent.session.header?.origin === 'subagent') fail('WRONG_AGENT');
  if (agent.session.header?.cwd !== config.workspace) fail('WRONG_WORKSPACE');
  const bytes = await ownedBytes(config, '.dsh-team-launcher.json', 4096, 'INVALID_LAUNCHER_MARKER_FILE');
  let marker;
  try { marker = JSON.parse(bytes.toString('utf8')); }
  catch { fail('INVALID_LAUNCHER_MARKER_JSON'); }
  if (!exact(marker, ['purpose', 'ownedSessionId', 'runTag', 'templateSha256'])
    || marker.purpose !== 'dsh-native-team-launcher' || marker.ownedSessionId !== config.ownedSessionId
    || marker.runTag !== config.runTag || marker.templateSha256 !== config.templateSha256) fail('INVALID_LAUNCHER_MARKER_BINDING');
  // File I/O can yield while the live registry or its Session header changes.
  if (ctx.agents.get(agent.id) !== agent || agent.id !== config.ownedSessionId || agent.session?.id !== agent.id
    || agent.session.header?.origin === 'subagent') fail('WRONG_AGENT');
  if (agent.session.header?.cwd !== config.workspace) fail('WRONG_WORKSPACE');
  assertWorkingDirectory(ctx, config, agent);
  return true;
}
