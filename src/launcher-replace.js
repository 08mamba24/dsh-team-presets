import { isDeepStrictEqual } from 'node:util';
import { fail } from './config.js';
import { parseReplacementRequest, readReplacementRecord, startReplacement, transitionReplacement,
  buildHandoffSnapshot, verifyReadinessAck, verifyTakeoverProof, eligibilityOf, currentRoleOwner,
  replacementRequestOf, replacementCandidateOf, recordOwnerWriteAttempt, recordTaskOutcome, REPLACEMENT_CHILD_ID } from './member-replacement.js';

const TERMINAL_TASK = new Set(['completed', 'deleted']);

function errorCode(error) {
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code
    : /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.message) ? error.message : 'REPLACEMENT_FAILED';
}

function operationOf(record, operationId) {
  const operation = record.operations.find(entry => entry.id === operationId);
  if (!operation) fail('REPLACEMENT_OPERATION_NOT_FOUND');
  return operation;
}

function stableTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = structuredClone(value);
  for (const key of ['revision', 'status', 'ownerId', 'ownerName', 'ready', 'writeScopeWarnings']) {
    Reflect.deleteProperty(result, key);
  }
  return result;
}

function taskPreserved(ref, task) {
  return ref.snapshot === undefined || isDeepStrictEqual(stableTask(ref.snapshot), stableTask(task));
}

function resultFor(operation) {
  const transferred = operation.taskOutcomes.filter(entry => entry.kind === 'transferred');
  const skipped = operation.taskOutcomes.filter(entry => entry.kind !== 'transferred');
  return { ok: true, operationId: operation.id, phase: operation.phase, role: operation.role,
    instanceName: operation.instanceName, oldChildId: operation.oldChildId, newChildId: operation.newChildId,
    handoffDigest: operation.handoffDigest, transferred, skipped, takeoverProof: operation.takeoverProof };
}

function validateChildId(childId) {
  if (typeof childId !== 'string' || !REPLACEMENT_CHILD_ID.test(childId)) {
    fail('REPLACEMENT_CHILD_INVALID');
  }
  return childId;
}

function contextFor(host) {
  if (!host || typeof host !== 'object' || typeof host.ownedSessionId !== 'function'
    || typeof host.readRecord !== 'function' || typeof host.writeRecord !== 'function') {
    fail('REPLACEMENT_HOST_UNAVAILABLE');
  }
  const signal = host.signal, now = () => host.now?.() ?? Date.now(), rootId = host.ownedSessionId();
  const readRow = async () => host.readRecord(rootId);
  let latestFence;
  const readRecord = async () => {
    const value = readReplacementRecord((await readRow())?.value, now());
    latestFence = value;
    return value;
  };

  /** Whole-entry CAS with exact readback. A thrown/false write may still have committed;
   * only an exact durable readback is accepted as success. */
  const writeRecord = async (next, baseline) => {
    const row = await readRow();
    const current = readReplacementRecord(row?.value, now());
    if (!isDeepStrictEqual(current, baseline)) fail('REPLACEMENT_PERSISTENCE_CONFLICT');
    let outcome, writeError;
    // If the write/readback boundary itself disappears, retain the attempted
    // fence locally. In particular, an attempted owner-write intent can never
    // fall back to a stale pre-CAS record and thaw the old member.
    latestFence = next;
    try { outcome = await host.writeRecord(rootId, JSON.parse(JSON.stringify(next)), row?.revision); }
    catch (error) { writeError = error; }
    let confirmed;
    try { confirmed = await readRecord(); } catch { fail('REPLACEMENT_PERSISTENCE_UNCONFIRMED'); }
    if (isDeepStrictEqual(confirmed, next)) { latestFence = confirmed; return confirmed; }
    if (writeError || outcome === true) fail('REPLACEMENT_PERSISTENCE_UNCONFIRMED');
    fail('REPLACEMENT_PERSISTENCE_CONFLICT');
  };
  const advance = async (record, operationId, phase, extra) => {
    const next = transitionReplacement(record, operationId, phase, now(), extra);
    return writeRecord(next, record);
  };
  const update = async (record, next) => writeRecord(next, record);
  return { host, signal, now, rootId, readRecord, writeRecord, advance, update,
    latestFence: () => latestFence };
}

async function enterRecovering(state, record, operationId) {
  const operation = operationOf(record, operationId);
  if (operation.phase === 'recovering') return record;
  if (!['transferring', 'activating'].includes(operation.phase)) return record;
  return state.advance(record, operationId, 'recovering');
}

/** Revoke candidate admission durably, then require interrupt+join evidence before thawing old. */
async function cancelBeforeOwnerWrite(state, record, operationId, originalCode) {
  let operation = operationOf(record, operationId);
  if (operation.ownerWriteAttempts.length || ['activating', 'recovering', 'active'].includes(operation.phase)) {
    record = await enterRecovering(state, record, operationId);
    return { record, result: { ok: false, code: originalCode, operationId, phase: operationOf(record, operationId).phase } };
  }
  if (operation.phase !== 'cancelling') record = await state.advance(record, operationId, 'cancelling');
  operation = operationOf(record, operationId);
  let cancelled;
  try {
    if (typeof state.host.cancelCandidate !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
    cancelled = await state.host.cancelCandidate({ operation, childId: operation.newChildId });
  } catch {
    return { record, result: { ok: false, code: 'REPLACEMENT_CANCELLATION_UNCONFIRMED',
      operationId, phase: 'cancelling', cause: originalCode } };
  }
  if (cancelled?.settled !== true) return { record,
    result: { ok: false, code: 'REPLACEMENT_CANCELLATION_UNCONFIRMED', operationId,
      phase: 'cancelling', cause: originalCode } };
  record = await state.advance(record, operationId, 'aborted');
  return { record, result: { ok: false, code: originalCode, operationId, phase: 'aborted' } };
}

async function bindCandidate(state, record, operationId, request, { allowSpawn }) {
  const operation = operationOf(record, operationId);
  const plan = replacementCandidateOf(operation);
  let candidate;
  if (allowSpawn) {
    if (typeof state.host.spawnCandidate !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
    candidate = await state.host.spawnCandidate({ request, operation });
  } else {
    if (typeof state.host.restoreCandidate !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
    candidate = await state.host.restoreCandidate({ request, operation });
    if (candidate?.found !== true) return { record, missing: true };
  }
  const childId = validateChildId(candidate?.childId);
  if (childId !== plan.childId) fail('REPLACEMENT_CHILD_CHANGED');
  if (operation.newChildId !== null && operation.newChildId !== childId) fail('REPLACEMENT_CHILD_CHANGED');
  if (operation.phase === 'frozen') record = await state.advance(record, operationId, 'standby', { newChildId: childId });
  return { record, childId };
}

async function readyCandidate(state, record, operationId) {
  const operation = operationOf(record, operationId);
  state.signal?.throwIfAborted();
  if (typeof state.host.awaitReadiness !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  const envelope = await state.host.awaitReadiness(operation.newChildId, operationId);
  const ack = verifyReadinessAck({ text: envelope?.text, senderSessionId: envelope?.senderSessionId,
    operation, at: state.now() });
  if (!ack.ok) return { record, ackError: ack.reason };
  if (typeof state.host.assertCandidateClean !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  await state.host.assertCandidateClean(operation.newChildId, operationId);
  record = await state.advance(record, operationId, 'ready', { readinessAck: ack.evidence });
  return { record };
}

async function persistOutcome(state, record, operationId, outcome) {
  return state.update(record, recordTaskOutcome(record, operationId, outcome, state.now()));
}

async function transferTasks(state, record, operationId) {
  let operation = operationOf(record, operationId);
  for (const ref of operation.taskRefs) {
    state.signal?.throwIfAborted();
    operation = operationOf(record, operationId);
    const cached = operation.taskOutcomes.find(entry => entry.taskId === ref.taskId);
    const current = await state.host.getTask(ref.taskId);
    if (cached !== undefined) {
      // A durable outcome is a recovery cursor, never authority for current native state.
      // Recheck every task before activation while preserving the original owner-CAS
      // revision needed to bind an already-observed candidate write.
      if (current === undefined) {
        if (cached.kind !== 'missing') record = await persistOutcome(state, record, operationId,
          { taskId: ref.taskId, kind: 'missing', revision: null });
        continue;
      }
      if (cached.kind === 'transferred') {
        const invalidRevision = !Number.isInteger(current.revision) || current.revision < cached.revision;
        if (invalidRevision) {
          record = await enterRecovering(state, record, operationId);
          return { record, error: 'REPLACEMENT_SNAPSHOT_STALE', taskId: ref.taskId };
        }
        if (TERMINAL_TASK.has(current.status)) {
          if (current.revision === cached.revision) {
            record = await enterRecovering(state, record, operationId);
            return { record, error: 'REPLACEMENT_SNAPSHOT_STALE', taskId: ref.taskId };
          }
          record = await persistOutcome(state, record, operationId,
            { taskId: ref.taskId, kind: current.status, revision: current.revision });
          continue;
        }
        if (current.ownerId !== operation.newChildId) {
          record = await enterRecovering(state, record, operationId);
          return { record, error: 'REPLACEMENT_SNAPSHOT_STALE', taskId: ref.taskId };
        }
        if (current.revision === cached.revision && !taskPreserved(ref, current)) {
          record = await enterRecovering(state, record, operationId);
          return { record, error: 'REPLACEMENT_SNAPSHOT_STALE', taskId: ref.taskId };
        }
        continue;
      }
      if (!TERMINAL_TASK.has(current.status) || !Number.isInteger(current.revision)
        || (cached.revision !== null && current.revision < cached.revision)) {
        record = await enterRecovering(state, record, operationId);
        return { record, error: 'REPLACEMENT_SNAPSHOT_STALE', taskId: ref.taskId };
      }
      if (cached.kind !== current.status || cached.revision !== current.revision) {
        record = await persistOutcome(state, record, operationId,
          { taskId: ref.taskId, kind: current.status, revision: current.revision });
      }
      continue;
    }
    if (current === undefined) {
      record = await persistOutcome(state, record, operationId,
        { taskId: ref.taskId, kind: 'missing', revision: null });
      continue;
    }
    if (TERMINAL_TASK.has(current.status)) {
      record = await persistOutcome(state, record, operationId,
        { taskId: ref.taskId, kind: current.status, revision: current.revision });
      continue;
    }
    operation = operationOf(record, operationId);
    const attempted = operation.ownerWriteAttempts.some(entry => entry.taskId === ref.taskId);
    if (current.ownerId === operation.newChildId) {
      if (!attempted || !taskPreserved(ref, current) || current.revision <= ref.revision) {
        record = await enterRecovering(state, record, operationId);
        return { record, error: 'REPLACEMENT_SNAPSHOT_STALE', taskId: ref.taskId };
      }
      record = await persistOutcome(state, record, operationId,
        { taskId: ref.taskId, kind: 'transferred', revision: current.revision });
      continue;
    }
    if (current.ownerId !== operation.oldChildId || current.revision !== ref.revision || !taskPreserved(ref, current)) {
      record = await enterRecovering(state, record, operationId);
      return { record, error: 'REPLACEMENT_SNAPSHOT_STALE', taskId: ref.taskId };
    }

    // Write-ahead owner intent is the irreversible fence: once durable, old can never thaw.
    record = await state.update(record,
      recordOwnerWriteAttempt(record, operationId, ref.taskId, ref.revision, state.now()));
    operation = operationOf(record, operationId);
    try {
      await state.host.reassignTask({ taskId: ref.taskId, expectedRevision: ref.revision,
        owner: operation.newChildId });
    } catch { /* authoritative readback below decides whether the write landed */ }
    let readback;
    try { readback = await state.host.getTask(ref.taskId); } catch { readback = undefined; }
    if (readback !== undefined && TERMINAL_TASK.has(readback.status)) {
      record = await persistOutcome(state, record, operationId,
        { taskId: ref.taskId, kind: readback.status, revision: readback.revision });
      continue;
    }
    if (readback?.ownerId !== operation.newChildId || !Number.isInteger(readback.revision)
      || readback.revision <= ref.revision || !taskPreserved(ref, readback)) {
      record = await enterRecovering(state, record, operationId);
      return { record, error: 'REPLACEMENT_TRANSFER_UNCONFIRMED', taskId: ref.taskId };
    }
    record = await persistOutcome(state, record, operationId,
      { taskId: ref.taskId, kind: 'transferred', revision: readback.revision });
  }
  return { record };
}

async function activateAndProve(state, record, operationId, request) {
  state.signal?.throwIfAborted();
  let operation = operationOf(record, operationId);
  if (operation.phase !== 'activating') record = await state.advance(record, operationId, 'activating');
  operation = operationOf(record, operationId);
  if (typeof state.host.activateCandidate !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  const activated = await state.host.activateCandidate({ operation, request });
  if (validateChildId(activated?.childId) !== operation.newChildId) fail('REPLACEMENT_CHILD_CHANGED');
  const transferred = operation.taskOutcomes.filter(entry => entry.kind === 'transferred');
  if (transferred.length === 0) {
    const proof = { kind: 'not-required', reason: 'no-unfinished-tasks', at: state.now() };
    record = await state.advance(record, operationId, 'active', { takeoverProof: proof });
    return { record };
  }
  if (typeof state.host.observeTakeover !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  state.signal?.throwIfAborted();
  const rawProof = await state.host.observeTakeover({ operation, transferred });
  const proof = verifyTakeoverProof({ proof: rawProof, operation, at: state.now() });
  if (!proof.ok) {
    record = await enterRecovering(state, record, operationId);
    return { record, error: proof.reason };
  }
  record = await state.advance(record, operationId, 'active', { takeoverProof: proof.evidence });
  return { record };
}

async function continueOperation(state, record, operationId, request, { allowSpawn }) {
  let operation = operationOf(record, operationId);
  if (operation.phase === 'active') return resultFor(operation);
  if (operation.phase === 'aborted') return { ok: false, code: 'REPLACEMENT_ABORTED', operationId, phase: 'aborted' };
  if (operation.phase === 'cancelling') {
    return (await cancelBeforeOwnerWrite(state, record, operationId, 'REPLACEMENT_CANCELLED')).result;
  }

  if (operation.phase === 'frozen') {
    const bound = await bindCandidate(state, record, operationId, request, { allowSpawn });
    record = bound.record;
    if (bound.missing) return { ok: false, code: 'REPLACEMENT_CANDIDATE_NOT_FOUND', operationId, phase: 'frozen' };
  } else if (!allowSpawn) {
    const restored = await bindCandidate(state, record, operationId, request, { allowSpawn: false });
    record = restored.record;
    if (restored.missing) return { ok: false, code: 'REPLACEMENT_CANDIDATE_NOT_FOUND',
      operationId, phase: operationOf(record, operationId).phase };
  }

  operation = operationOf(record, operationId);
  if (operation.phase === 'standby') {
    const ready = await readyCandidate(state, record, operationId);
    record = ready.record;
    if (ready.ackError) return (await cancelBeforeOwnerWrite(state, record, operationId, ready.ackError)).result;
  }

  operation = operationOf(record, operationId);
  if (operation.phase === 'ready') record = await state.advance(record, operationId, 'transferring');
  else if (operation.phase === 'recovering') record = await state.advance(record, operationId, 'transferring');

  operation = operationOf(record, operationId);
  if (operation.phase === 'transferring') {
    const transferred = await transferTasks(state, record, operationId);
    record = transferred.record;
    if (transferred.error) return { ok: false, code: transferred.error, operationId,
      phase: operationOf(record, operationId).phase, taskId: transferred.taskId,
      transferred: operationOf(record, operationId).taskOutcomes.filter(entry => entry.kind === 'transferred') };
  }

  operation = operationOf(record, operationId);
  if (operation.phase === 'transferring' || operation.phase === 'activating') {
    const activated = await activateAndProve(state, record, operationId, request);
    record = activated.record;
    if (activated.error) return { ok: false, code: activated.error, operationId,
      phase: operationOf(record, operationId).phase };
  }
  return resultFor(operationOf(record, operationId));
}

async function guardOperation(state, record, operationId, work) {
  try { return await work(); }
  catch (error) {
    let latest = state.latestFence() ?? record;
    try { latest = await state.readRecord(); } catch { /* the confirmed frozen/transfer state remains fail-closed */ }
    const operation = latest.operations.find(entry => entry.id === operationId);
    if (operation && !['active', 'aborted', 'cancelling'].includes(operation.phase)) {
      if (operation.ownerWriteAttempts.length || ['activating', 'recovering'].includes(operation.phase)) {
        try { await enterRecovering(state, latest, operationId); } catch { /* retain the earlier fail-closed phase */ }
      } else {
        try { await cancelBeforeOwnerWrite(state, latest, operationId, errorCode(error)); }
        catch { /* a failed cancellation never thaws old */ }
      }
    }
    throw error;
  }
}

/** Start a new replacement. Existing durable mapping selects the exact current role instance. */
export async function replaceMember(host, rawRequest) {
  const state = contextFor(host);
  const request = parseReplacementRequest(rawRequest);
  state.signal?.throwIfAborted();
  if (typeof host.preflight !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  await host.preflight(request);

  let record = await state.readRecord();
  const mappedChildId = currentRoleOwner(record, request.role);
  if (mappedChildId !== undefined && request.expectedOldChildId !== undefined
    && mappedChildId !== request.expectedOldChildId) fail('REPLACEMENT_MEMBER_CHANGED');
  const expectedChildId = request.expectedOldChildId ?? mappedChildId;
  state.signal?.throwIfAborted();
  if (typeof host.observeMember !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  const observation = await host.observeMember(request.role, expectedChildId);
  if (!observation?.available) fail(request.expectedOldChildId === undefined
    ? 'REPLACEMENT_MEMBER_UNOBSERVABLE' : 'REPLACEMENT_MEMBER_CHANGED');
  if (!observation.quiet) fail('REPLACEMENT_MEMBER_NOT_QUIET');
  validateChildId(observation.childId);
  if (expectedChildId !== undefined && observation.childId !== expectedChildId) fail('REPLACEMENT_MEMBER_CHANGED');
  if (eligibilityOf(record, observation.childId).kind !== 'full') fail('REPLACEMENT_OLD_MEMBER_INELIGIBLE');

  state.signal?.throwIfAborted();
  if (typeof host.listTasks !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  const board = await host.listTasks();
  if (!Array.isArray(board)) fail('REPLACEMENT_TASK_BOARD_INVALID');
  const owned = board.filter(task => task?.ownerId === observation.childId);
  if (owned.some(task => !TERMINAL_TASK.has(task?.status)) && !request.tools.includes('team_task_update')) {
    fail('REPLACEMENT_TAKEOVER_TOOL_REQUIRED');
  }
  const snapshot = buildHandoffSnapshot({ role: request.role, tasks: owned, progress: request.progressFacts });
  if (typeof host.uniqueInstanceName !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  const instanceName = await host.uniqueInstanceName(request.role);
  const candidateConfig = JSON.stringify(request);
  const started = startReplacement(record, { role: request.role, oldChildId: observation.childId,
    handoffDigest: snapshot.handoffDigest, taskRefs: snapshot.taskRefs, handoffText: snapshot.text,
    candidateConfig, instanceName }, state.now());

  state.signal?.throwIfAborted();
  if (typeof host.runMaintenanceExclusive !== 'function' || typeof host.assertMemberStillQuiet !== 'function') {
    fail('REPLACEMENT_HOST_UNAVAILABLE');
  }
  record = await host.runMaintenanceExclusive(observation.childId, async () => {
    await host.assertMemberStillQuiet(request.role, observation.childId);
    const frozen = await state.writeRecord(started.record, record);
    await host.assertMemberStillQuiet(request.role, observation.childId, { phase: 'post-freeze',
      handoffDigest: snapshot.handoffDigest, taskRefs: snapshot.taskRefs });
    return frozen;
  });
  const operationId = started.operationId;
  return guardOperation(state, record, operationId,
    () => continueOperation(state, record, operationId, request, { allowSpawn: true }));
}

/** Explicit recovery: inspect one durable operation, restore only its planned candidate,
 * reconcile native task owners, and resume activation/proof without blind spawn. */
export async function reconcileReplacement(host, operationId) {
  const state = contextFor(host);
  let record = await state.readRecord(), operation = operationOf(record, operationId);
  if (operation.phase === 'active') return resultFor(operation);
  if (operation.phase === 'aborted') return { ok: false, code: 'REPLACEMENT_ABORTED', operationId, phase: 'aborted' };
  const request = replacementRequestOf(operation);
  if (typeof host.preflight !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  await host.preflight(request);
  if (operation.phase === 'cancelling') return (await cancelBeforeOwnerWrite(state, record,
    operationId, 'REPLACEMENT_CANCELLED')).result;
  return guardOperation(state, record, operationId,
    () => continueOperation(state, record, operationId, request, { allowSpawn: false }));
}

/** A frozen operation without a published candidate still needs a safe user
 * exit after a crash. Cancellation is explicit and forbidden after owner intent. */
export async function cancelReplacement(host, operationId) {
  const state = contextFor(host);
  state.signal?.throwIfAborted();
  const record = await state.readRecord(), operation = operationOf(record, operationId);
  if (operation.phase === 'aborted') return { ok: true, cancelled: true, operationId, phase: 'aborted' };
  if (operation.ownerWriteAttempts.length || !['frozen', 'standby', 'ready', 'transferring', 'cancelling'].includes(operation.phase)) {
    fail('REPLACEMENT_CANNOT_CANCEL_AFTER_TRANSFER');
  }
  const { result } = await cancelBeforeOwnerWrite(state, record, operationId, 'REPLACEMENT_CANCELLED');
  return { ...result, ok: result.phase === 'aborted', cancelled: result.phase === 'aborted' };
}

/** Compatibility helper for callers that already collected runtime writes. New orchestration
 * uses observeTakeover and persists the verified proof before returning success. */
export function takeoverProof({ childRuntimeWrites, newChildId, transferred, operationId, handoffDigest }) {
  if (!Array.isArray(childRuntimeWrites) || !Array.isArray(transferred)) fail('REPLACEMENT_PROOF_INVALID');
  const expected = new Map(transferred.map(entry => [entry.taskId, entry.revision]));
  const proof = childRuntimeWrites.find(write => write.childId === newChildId && expected.has(write.taskId)
    && write.success === true && Number.isInteger(write.revision)
    && write.expectedRevision >= expected.get(write.taskId) && write.revision === write.expectedRevision + 1
    && (operationId === undefined || write.operationId === operationId)
    && (handoffDigest === undefined || write.handoffDigest === handoffDigest));
  return proof ? { proven: true, taskId: proof.taskId, revision: proof.revision } : { proven: false };
}
