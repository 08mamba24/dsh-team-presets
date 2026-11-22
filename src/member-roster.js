import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { fail } from './config.js';

/** Durable explicit membership changes for one bound root team. The base binding
 * template stays immutable; additions and removals are ordered entries beside the
 * replacement operations. Native catalog, tasks and Sessions remain authoritative. */
export const MEMBER_LIMIT = 8;
export const MEMBER_ENTRY_ID = /^member-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const CHILD_ID = /^(?:session-[a-zA-Z0-9][a-zA-Z0-9-]{6,62}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ADD_PHASES = new Set(['spawning', 'active', 'failed', 'aborted']);
const MEMBER_LIMIT_BYTES = 65_536;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};

/** The JSON-encoded template member for an addition, with its root-scoped Preset id. */
export function additionMemberOf(entry) {
  if (entry?.kind !== 'add') fail('MEMBER_ENTRY_INVALID');
  return JSON.parse(entry.member);
}

function parseEntry(raw) {
  if (!plain(raw) || typeof raw.id !== 'string' || !MEMBER_ENTRY_ID.test(raw.id)
    || typeof raw.name !== 'string' || !NAME.test(raw.name) || raw.name === 'lead'
    || !Number.isInteger(raw.at) || raw.at < 0) fail('MEMBER_ENTRY_INVALID');
  if (raw.kind === 'add') {
    if (!exactKeys(raw, ['id', 'kind', 'name', 'phase', 'at', 'childId', 'member']) || !ADD_PHASES.has(raw.phase)
      || typeof raw.childId !== 'string' || !CHILD_ID.test(raw.childId)
      || typeof raw.member !== 'string' || raw.member.length > MEMBER_LIMIT_BYTES) fail('MEMBER_ENTRY_INVALID');
    let member;
    try { member = JSON.parse(raw.member); } catch { fail('MEMBER_ENTRY_INVALID'); }
    if (!plain(member) || member.name !== raw.name || typeof member.agent_preset !== 'string') fail('MEMBER_ENTRY_INVALID');
    return { ...raw };
  }
  if (raw.kind === 'remove') {
    if (!exactKeys(raw, ['id', 'kind', 'name', 'phase', 'at', 'childId']) || raw.phase !== 'removed'
      || (raw.childId !== null && (typeof raw.childId !== 'string' || !CHILD_ID.test(raw.childId)))) fail('MEMBER_ENTRY_INVALID');
    return { ...raw };
  }
  fail('MEMBER_ENTRY_INVALID');
}

/** Validate ordering: a name is added at most once, removed at most once, and never reused after removal. */
export function parseMembership(raw) {
  if (!Array.isArray(raw) || types.isProxy(raw) || raw.length === 0 || raw.length > 64) fail('MEMBER_ENTRY_INVALID');
  const entries = raw.map(parseEntry), ids = new Set(), added = new Set(), removed = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id) || removed.has(entry.name)) fail('MEMBER_ENTRY_INVALID');
    ids.add(entry.id);
    if (entry.kind === 'add') {
      if (added.has(entry.name)) fail('MEMBER_ENTRY_INVALID');
      added.add(entry.name);
    } else removed.add(entry.name);
  }
  return freeze(entries);
}

/** Effective roster: base template members plus explicit additions, minus removals. */
export function rosterOf(record, baseMembers) {
  const membership = record.membership ?? [];
  const removed = new Map(membership.filter(entry => entry.kind === 'remove').map(entry => [entry.name, entry]));
  const additions = membership.filter(entry => entry.kind === 'add');
  const members = [
    ...baseMembers.map(member => ({ name: member.name, origin: 'template', phase: 'active', member })),
    ...additions.map(entry => ({ name: entry.name, origin: 'added', phase: entry.phase, childId: entry.childId,
      entryId: entry.id, member: additionMemberOf(entry) })),
  ];
  return freeze({
    members: members.filter(row => !removed.has(row.name)),
    removed: [...removed.values()].map(entry => ({ name: entry.name, childId: entry.childId })),
    names: new Set(members.map(row => row.name)),
  });
}

/** Append a pending addition; the caller persists before registering a Preset or spawning. */
export function appendAddition(membership, { name, member, at = Date.now() }) {
  const id = `member-${randomUUID()}`;
  const entry = { id, kind: 'add', name, phase: 'spawning', at, childId: `session-${id.slice('member-'.length)}`,
    member: JSON.stringify(member) };
  return { entry, membership: [...membership, entry] };
}

export function settleAddition(membership, entryId, phase, at = Date.now()) {
  if (!['active', 'failed', 'aborted'].includes(phase)) fail('MEMBER_ENTRY_INVALID');
  let found = false;
  const next = membership.map(entry => {
    if (entry.id !== entryId) return entry;
    if (entry.kind !== 'add' || entry.phase !== 'spawning') fail('MEMBER_ADDITION_NOT_PENDING');
    found = true;
    return { ...entry, phase, at };
  });
  if (!found) fail('MEMBER_ADDITION_NOT_FOUND');
  return next;
}

export function appendRemoval(membership, { name, childId, at = Date.now() }) {
  const entry = { id: `member-${randomUUID()}`, kind: 'remove', name, phase: 'removed', at, childId };
  return { entry, membership: [...membership, entry] };
}
