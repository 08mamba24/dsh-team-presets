import { types } from 'node:util';
import { fail } from './config.js';

const TASK_FIELDS = ['id', 'revision', 'subject', 'description', 'status', 'ownerId', 'ownerName', 'blockedBy', 'writeScopes'];
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const integer = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const invalid = () => fail('LAUNCHER_BOARD_INVALID');

// Copy every data field, including unknown metadata and explicit undefined values.
function copy(value, ancestors = new Set()) {
  if (value === null || value === undefined || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value), result = array ? [] : {};
  if (array && keys.length !== value.length + 1) invalid();
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value')) invalid();
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
    Object.defineProperty(result, key, { value: copy(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function task(value) {
  if (!record(value) || !text(value.id) || !integer(value.revision, 1)
    || typeof value.subject !== 'string' || typeof value.description !== 'string'
    || !['pending', 'in_progress', 'completed', 'deleted'].includes(value.status)
    || !Array.isArray(value.blockedBy) || value.blockedBy.some(id => !text(id))
    || !Array.isArray(value.writeScopes) || value.writeScopes.some(scope => typeof scope !== 'string')
    || (value.ownerId !== undefined && !text(value.ownerId))
    || (value.ownerName !== undefined && (!text(value.ownerName) || value.ownerId === undefined))) invalid();
  const numeric = /^task-(\d+)$/u.exec(value.id);
  if (numeric && !Number.isSafeInteger(Number(numeric[1]))) invalid();
}

/** Detached complete native TeamProjectionState, never the filtered wire/list view. */
export function snapshotLauncherBoard(raw) {
  const value = copy(raw);
  if (!record(value) || !text(value.id) || !integer(value.inheritedEventCount, 0)
    || !integer(value.nextTaskNumber, 1) || !Array.isArray(value.tasks)
    || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    || (value.failure !== undefined && typeof value.failure !== 'string')) invalid();
  const ids = new Set();
  for (const entry of value.tasks) { task(entry); if (ids.has(entry.id)) invalid(); ids.add(entry.id); }
  return freeze(value);
}

/** All metadata, tombstones, ordering and property presence participate in authority. */
export function sameLauncherBoard(left, right) {
  return canonical(snapshotLauncherBoard(left)) === canonical(snapshotLauncherBoard(right));
}

/** Native team/mode projection is a spread changing enabled alone. */
export function launcherBoardWithMode(expected, enabled) {
  if (typeof enabled !== 'boolean') invalid();
  return snapshotLauncherBoard({ ...snapshotLauncherBoard(expected), enabled });
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
}
function requiredText(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) invalid();
  return value.trim();
}
function rawView(view) {
  const value = copy(view);
  if (!record(value) || typeof value.ready !== 'boolean' || !Array.isArray(value.writeScopeWarnings)
    || value.writeScopeWarnings.some(warning => typeof warning !== 'string')) invalid();
  delete value.ready; delete value.writeScopeWarnings;
  task(value);
  return value;
}
function publicTask(value) {
  // projectTaskView enumerates these fields. Unknown raw metadata remains in the
  // expected board and must still match the independently observed raw state.
  return Object.fromEntries(TASK_FIELDS.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function confirmed(value, view) {
  if (canonical(publicTask(value)) !== canonical(rawView(view))) fail('LAUNCHER_BOARD_WRITE_UNCONFIRMED');
}
function writable(expected) {
  const value = snapshotLauncherBoard(expected);
  if (value.enabled !== true || value.failure !== undefined) fail('LAUNCHER_BOARD_NOT_WRITABLE');
  return value;
}
function counterAfter(value, id) {
  const match = /^task-(\d+)$/u.exec(id);
  if (!match) return value;
  const number = Number(match[1]);
  return Math.max(value, number === Number.MAX_SAFE_INTEGER ? number : number + 1);
}

/** Advance only the acknowledged native create; never adopt a whole after-state. */
export function launcherBoardAfterCreate(expected, request, createdView) {
  const before = writable(expected), input = copy(request);
  if (!record(input) || Object.keys(input).some(key => !['subject', 'description', 'blockedBy', 'writeScopes'].includes(key))) invalid();
  const blockedBy = input.blockedBy ?? [], scopes = input.writeScopes ?? [];
  if (!Array.isArray(blockedBy) || new Set(blockedBy).size !== blockedBy.length
    || blockedBy.some(id => !text(id) || !before.tasks.some(entry => entry.id === id && entry.status !== 'deleted'))
    || !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) invalid();
  const writeScopes = [...new Set(scopes.map(scope => {
    const normalized = scope.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
      || normalized.split('/').some(part => !part || part === '.' || part === '..')) invalid();
    return normalized;
  }))];
  const value = { id: `task-${before.nextTaskNumber}`, revision: 1, subject: requiredText(input.subject, 200),
    description: requiredText(input.description, 16_384), status: 'pending', blockedBy: [...blockedBy], writeScopes };
  if (before.tasks.some(entry => entry.id === value.id)) fail('LAUNCHER_BOARD_WRITE_UNCONFIRMED');
  confirmed(value, createdView);
  const raw = rawView(createdView);
  return snapshotLauncherBoard({ ...before, tasks: [...before.tasks, raw], nextTaskNumber: counterAfter(before.nextTaskNumber, raw.id) });
}

/** Scope is the launcher's confirmed claim / description edit / complete subset. */
export function launcherBoardAfterUpdate(expected, request, actor, confirmedView) {
  const before = writable(expected), input = copy(request), caller = copy(actor);
  const keys = input?.action === 'edit' ? ['taskId', 'expectedRevision', 'action', 'description'] : ['taskId', 'expectedRevision', 'action'];
  if (!exactKeys(input, keys) || !['claim', 'edit', 'complete'].includes(input.action)
    || !record(caller) || !text(caller.id) || (caller.name !== undefined && !text(caller.name))) invalid();
  const index = before.tasks.findIndex(entry => entry.id === input.taskId), previous = before.tasks[index];
  if (!previous || previous.revision !== input.expectedRevision || previous.status === 'deleted'
    || previous.revision === Number.MAX_SAFE_INTEGER) fail('LAUNCHER_BOARD_WRITE_UNCONFIRMED');
  const next = copy(previous); next.revision++;
  if (input.action === 'claim') {
    if (!text(caller.name) || previous.status !== 'pending' || (previous.ownerId !== undefined && previous.ownerId !== caller.id)
      || previous.blockedBy.some(id => before.tasks.find(entry => entry.id === id)?.status !== 'completed')) fail('LAUNCHER_BOARD_WRITE_UNCONFIRMED');
    delete next.ownerId; delete next.ownerName;
    next.status = 'in_progress'; next.ownerId = caller.id;
    if (caller.name !== caller.id) next.ownerName = caller.name;
  } else {
    if (previous.status !== 'in_progress' || previous.ownerId !== caller.id) fail('LAUNCHER_BOARD_WRITE_UNCONFIRMED');
    if (input.action === 'edit') next.description = requiredText(input.description, 16_384);
    else next.status = 'completed';
  }
  confirmed(next, confirmedView);
  const tasks = [...before.tasks]; tasks[index] = next;
  return snapshotLauncherBoard({ ...before, tasks, nextTaskNumber: counterAfter(before.nextTaskNumber, next.id) });
}
