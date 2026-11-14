import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotLauncherBoard, sameLauncherBoard, launcherBoardWithMode, launcherBoardAfterCreate, launcherBoardAfterUpdate } from '../src/launcher-board.js';

const tombstone = () => ({ id: 'task-1', revision: 4, subject: 'Old task', description: 'Kept tombstone',
  status: 'deleted', ownerId: 'old-member', ownerName: 'old/path', blockedBy: [], writeScopes: ['old'] });
const state = () => ({ inheritedEventCount: 0, id: 'root', tasks: [tombstone()], nextTaskNumber: 2,
  extraMetadata: { revision: 7, optional: undefined } });
const view = raw => ({ ...structuredClone(raw), ready: raw.status === 'pending', writeScopeWarnings: [] });
const visible = raw => raw.tasks.filter(entry => entry.status !== 'deleted');
const request = { subject: ' Implementation ', description: ' Do work ', blockedBy: [], writeScopes: [] };
const created = () => ({ id: 'task-2', revision: 1, subject: 'Implementation', description: 'Do work', status: 'pending', blockedBy: [], writeScopes: [] });
const actor = { id: 'child-implementer', name: 'implementer' };
const failure = code => error => error.code === code && error.message === code;

test('full raw snapshot is detached and compares unknown metadata, property presence and ownerName', () => {
  const raw = state(), expected = snapshotLauncherBoard(raw);
  raw.tasks[0].ownerName = 'changed'; raw.extraMetadata.revision++;
  assert.equal(expected.tasks[0].ownerName, 'old/path'); assert.equal(expected.extraMetadata.revision, 7);
  assert.equal(Object.hasOwn(expected, 'enabled'), false); assert.equal(Object.hasOwn(expected.extraMetadata, 'optional'), true);
  assert.equal(Object.isFrozen(expected.tasks[0]), true);
  assert.equal(sameLauncherBoard(expected, { extraMetadata: { optional: undefined, revision: 7 }, nextTaskNumber: 2,
    tasks: [tombstone()], id: 'root', inheritedEventCount: 0 }), true);
  for (const mutate of [value => { value.tasks[0].ownerName = 'foreign'; }, value => { value.extraMetadata.revision++; },
    value => { delete value.extraMetadata.optional; }, value => { value.inheritedEventCount++; }]) {
    const changed = structuredClone(expected); mutate(changed); assert.equal(sameLauncherBoard(expected, changed), false);
  }
});

test('external create then delete is invisible in a list view but changes complete authority', () => {
  const expected = launcherBoardWithMode(state(), true), foreign = structuredClone(expected);
  foreign.tasks.push({ ...created(), revision: 2, status: 'deleted' }); foreign.nextTaskNumber = 3;
  assert.deepEqual(visible(foreign), visible(expected));
  assert.equal(sameLauncherBoard(foreign, expected), false);
  const restoredMode = launcherBoardWithMode(expected, false);
  assert.equal(sameLauncherBoard({ ...foreign, enabled: false }, restoredMode), false);
});

test('counter-only drift and tombstone-only drift are conflicts even with equal visible tasks', () => {
  const expected = snapshotLauncherBoard(state());
  assert.equal(sameLauncherBoard({ ...expected, nextTaskNumber: 3 }, expected), false);
  const changed = structuredClone(expected); changed.tasks[0].description = 'external tombstone change';
  assert.deepEqual(visible(changed), visible(expected)); assert.equal(sameLauncherBoard(changed, expected), false);
});

test('unchanged old tombstone survives explicit mode create claim edit complete and restore transitions', () => {
  let expected = launcherBoardWithMode(state(), true);
  expected = launcherBoardAfterCreate(expected, request, view(created()));
  const claimed = { ...created(), revision: 2, status: 'in_progress', ownerId: actor.id, ownerName: actor.name };
  expected = launcherBoardAfterUpdate(expected, { taskId: 'task-2', expectedRevision: 1, action: 'claim' }, actor, view(claimed));
  const edited = { ...claimed, revision: 3, description: 'Confirmed edit' };
  expected = launcherBoardAfterUpdate(expected, { taskId: 'task-2', expectedRevision: 2, action: 'edit', description: ' Confirmed edit ' }, actor, view(edited));
  const completed = { ...edited, revision: 4, status: 'completed' };
  expected = launcherBoardAfterUpdate(expected, { taskId: 'task-2', expectedRevision: 3, action: 'complete' }, actor, view(completed));
  expected = launcherBoardWithMode(expected, false);
  const actual = { ...state(), enabled: false, tasks: [tombstone(), completed], nextTaskNumber: 3 };
  assert.equal(sameLauncherBoard(actual, expected), true); assert.deepEqual(expected.tasks[0], tombstone());
  assert.equal(Object.hasOwn(expected.tasks[1], 'ready'), false); assert.equal(Object.hasOwn(expected.tasks[1], 'writeScopeWarnings'), false);
});

test('CAS confirmation preserves unprojected raw fields and exact native owner-name behavior', () => {
  const raw = { ...state(), enabled: true, tasks: [{ ...created(), extraTaskMetadata: { marker: 'retained' } }], nextTaskNumber: 3 };
  const unnamed = { id: 'unnamed-child', name: 'unnamed-child' };
  const confirmed = { ...created(), revision: 2, status: 'in_progress', ownerId: unnamed.id };
  const expected = launcherBoardAfterUpdate(raw, { taskId: 'task-2', expectedRevision: 1, action: 'claim' }, unnamed, view(confirmed));
  assert.equal(Object.hasOwn(expected.tasks[0], 'ownerName'), false);
  assert.deepEqual(expected.tasks[0].extraTaskMetadata, { marker: 'retained' });
  const actual = { ...raw, tasks: [{ ...confirmed, extraTaskMetadata: { marker: 'retained' } }] };
  assert.equal(sameLauncherBoard(expected, actual), true);
  actual.tasks[0].extraTaskMetadata.marker = 'external'; assert.equal(sameLauncherBoard(expected, actual), false);
});

test('an acknowledged view cannot authorize wrong ids counters owners revisions or new metadata', () => {
  const enabled = launcherBoardWithMode(state(), true);
  assert.throws(() => launcherBoardAfterCreate(enabled, request, view({ ...created(), id: 'task-3' })), failure('LAUNCHER_BOARD_WRITE_UNCONFIRMED'));
  assert.throws(() => launcherBoardAfterCreate(enabled, request, view({ ...created(), futureMetadata: 'unknown' })), failure('LAUNCHER_BOARD_WRITE_UNCONFIRMED'));
  const own = launcherBoardAfterCreate(enabled, request, view(created()));
  for (const changed of [{ ownerName: 'foreign' }, { revision: 3 }, { subject: 'unrequested edit' }]) {
    const claimed = { ...created(), revision: 2, status: 'in_progress', ownerId: actor.id, ownerName: actor.name, ...changed };
    assert.throws(() => launcherBoardAfterUpdate(own, { taskId: 'task-2', expectedRevision: 1, action: 'claim' }, actor, view(claimed)), failure('LAUNCHER_BOARD_WRITE_UNCONFIRMED'));
  }
  assert.equal(own.nextTaskNumber, 3); assert.equal(own.tasks[1].revision, 1);
  assert.throws(() => snapshotLauncherBoard({ ...state(), tasks: [tombstone(), tombstone()] }), failure('LAUNCHER_BOARD_INVALID'));
});
