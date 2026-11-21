import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplacementStore, readReplacementRow, REPLACEMENT_OWNER } from '../src/replacement-store.js';
import { readReplacementRecord, startReplacement } from '../src/member-replacement.js';

const ROOT = 'session-10000000-0000-4000-8000-000000000001';
const OTHER = 'session-10000000-0000-4000-8000-000000000002';
const OLD = 'session-10000000-0000-4000-8000-000000000003';
const empty = () => readReplacementRecord(undefined);
const frozen = () => startReplacement(empty(), { role: 'implementer', oldChildId: OLD,
  handoffDigest: 'a'.repeat(64), taskRefs: [] }).record;

function fixture() {
  let revision = 'entry-revision-1';
  const value = { template: { original: true }, replacementRecords: { [OTHER]: empty() } };
  const mutations = [];
  const settings = {
    describe: () => [{ ns: REPLACEMENT_OWNER, revision, value: structuredClone(value) }],
    async mutate(ns, patches, expectedRevision) {
      assert.equal(ns, REPLACEMENT_OWNER);
      if (expectedRevision !== revision) throw new Error('NATIVE_ENTRY_REVISION_CONFLICT');
      mutations.push(structuredClone(patches));
      for (const patch of patches) value.replacementRecords[patch.path[1]] = structuredClone(patch.value);
      revision += '-next';
    },
  };
  return { settings, value, mutations, store: createReplacementStore(settings, ROOT),
    changeTemplate() { value.template = { changedConcurrently: true }; revision += '-template'; } };
}

test('the native entry persists one complete root record while preserving the template and other roots', async () => {
  const h = fixture(), before = h.store.read(), record = frozen();
  assert.equal(await h.store.write(record, before.revision), true);
  assert.deepEqual(h.value.replacementRecords[ROOT], record);
  assert.deepEqual(h.value.replacementRecords[OTHER], empty());
  assert.deepEqual(h.value.template, { original: true });
  assert.deepEqual(h.mutations, [[{ op: 'set', path: ['replacementRecords', ROOT], value: record }]]);
});

test('a template or other-root edit invalidates the whole-entry revision without overwriting either root', async () => {
  const h = fixture(), before = h.store.read();
  h.changeTemplate();
  assert.equal(await h.store.write(frozen(), before.revision), false);
  assert.equal(h.mutations.length, 0);
  assert.equal(Object.hasOwn(h.value.replacementRecords, ROOT), false);
  assert.deepEqual(h.value.template, { changedConcurrently: true });
});

test('initialization creates a permanent empty root partition and never overwrites existing retirement', async () => {
  const h = fixture();
  await h.store.ensure();
  assert.deepEqual(h.value.replacementRecords[ROOT], empty());
  const record = frozen();
  await h.store.write(record, h.store.read().revision);
  const mutations = h.mutations.length;
  assert.deepEqual(await h.store.ensure(), record);
  assert.equal(h.mutations.length, mutations);
  assert.deepEqual(h.store.read({ requirePartition: true }).value, record);
});

test('successful mutation with a different readback never confirms persistence', async () => {
  const h = fixture();
  h.settings.mutate = async () => {};
  await assert.rejects(h.store.write(frozen(), h.store.read().revision), /REPLACEMENT_PARTITION_UNAVAILABLE/);
});

test('inactive, duplicate, missing and corrupt native owner projections cannot become empty records', () => {
  const row = value => ({ ns: REPLACEMENT_OWNER, revision: 'revision', value });
  for (const rows of [[], [row({})], [row({ replacementRecords: {} }), row({ replacementRecords: {} })],
    [row({ replacementRecords: { [ROOT]: null } })], [row({ replacementRecords: { [ROOT]: { version: 9 } } })]]) {
    assert.throws(() => readReplacementRow({ describe: () => rows }, ROOT, { requirePartition: true }));
  }
  assert.throws(() => readReplacementRow({ describe: () => [] }, 'not-a-session'), /REPLACEMENT_OWNER_INVALID/);
});
