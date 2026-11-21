import { isDeepStrictEqual } from 'node:util';
import { fail } from './config.js';
import { readReplacementRecord, ensureReplacementBaseBinding } from './member-replacement.js';

// Settings namespaces are activated profile entry ids. Roots are partitions
// inside this existing owner; every partition shares the entry's revision.
export const REPLACEMENT_OWNER = 'dsh-native-current-team';
export const ROOT_SESSION_ID = /^session-[a-zA-Z0-9][a-zA-Z0-9-]{6,62}$/;

export function readReplacementRow(settings, rootId, { requirePartition = false } = {}) {
  if (typeof rootId !== 'string' || !ROOT_SESSION_ID.test(rootId)) fail('REPLACEMENT_OWNER_INVALID');
  if (typeof settings?.describe !== 'function') fail('REPLACEMENT_STORE_UNAVAILABLE');
  const rows = settings.describe({ redactSecrets: true });
  if (!Array.isArray(rows)) fail('REPLACEMENT_STORE_INVALID');
  const owners = rows.filter(row => row?.ns === REPLACEMENT_OWNER);
  if (owners.length === 0) fail('REPLACEMENT_STORE_UNAVAILABLE');
  if (owners.length !== 1) fail('REPLACEMENT_STORE_INVALID');
  const row = owners[0], records = row.value?.replacementRecords;
  if (!records || typeof records !== 'object' || Array.isArray(records)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(records))
    || row.revision === undefined || row.revision === null) fail('REPLACEMENT_STORE_INVALID');
  const present = Object.hasOwn(records, rootId);
  if (!present && requirePartition) fail('REPLACEMENT_PARTITION_UNAVAILABLE');
  const value = present ? records[rootId] : undefined;
  // null is a corrupt durable partition, never an empty/legacy record.
  if (present && (value === undefined || value === null)) fail('REPLACEMENT_RECORD_INVALID');
  if (present) readReplacementRecord(value);
  return { revision: row.revision, value };
}

export function createReplacementStore(settings, rootId) {
  const read = options => readReplacementRow(settings, rootId, options);
  const write = async (value, expectedRevision) => {
    const record = readReplacementRecord(value);
    if (value === undefined || value === null) fail('REPLACEMENT_RECORD_INVALID');
    const before = read();
    if (before.revision !== expectedRevision) return false;
    if (typeof settings.mutate !== 'function') fail('REPLACEMENT_STORE_UNAVAILABLE');
    // A complete root record replaces its previous value. Recursive update/merge
    // would retain stale fields; replacing the whole map would erase other roots.
    await settings.mutate(REPLACEMENT_OWNER, [{ op: 'set',
      path: ['replacementRecords', rootId], value: structuredClone(record) }], expectedRevision);
    const after = read({ requirePartition: true });
    if (after.revision === expectedRevision && !isDeepStrictEqual(before.value, record)) fail('REPLACEMENT_PERSISTENCE_UNCONFIRMED');
    if (!isDeepStrictEqual(readReplacementRecord(after.value), record)) fail('REPLACEMENT_PERSISTENCE_UNCONFIRMED');
    return true;
  };
  return { read, write, async ensure(baseBinding) {
    const row = read();
    const record = readReplacementRecord(row.value);
    if (row.value !== undefined && (baseBinding === undefined || record.baseBinding !== undefined)) {
      if (baseBinding !== undefined && !isDeepStrictEqual(JSON.parse(record.baseBinding), JSON.parse(baseBinding))) fail('CURRENT_SESSION_BINDING_CHANGED');
      return record;
    }
    if (baseBinding !== undefined && record.operations.length) fail('REPLACEMENT_BASE_BINDING_UNAVAILABLE');
    const next = baseBinding === undefined ? record : ensureReplacementBaseBinding(record, baseBinding);
    if (!await write(next, row.revision)) fail('REPLACEMENT_PERSISTENCE_CONFLICT');
    return next;
  } };
}
