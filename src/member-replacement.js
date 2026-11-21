import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { fail } from './config.js';
import { selectableRoleTool, validRoleToolList, COLLABORATION_TOOLS } from './role-tools.js';

/** Root-owned durable replacement record. Native task ownership stays authoritative;
 * this record fences execution and retains the evidence needed to resume safely. */
export const REPLACEMENT_RECORD_VERSION = 1;
export const REPLACEMENT_PHASES = Object.freeze(['frozen', 'standby', 'ready', 'transferring',
  'activating', 'active', 'cancelling', 'aborted', 'recovering']);
const OLD_FROZEN = new Set(['frozen', 'standby', 'ready', 'transferring', 'activating',
  'active', 'cancelling', 'recovering']);
const CANDIDATE_STANDBY = new Set(['frozen', 'standby', 'ready', 'transferring', 'recovering']);
const CANDIDATE_ACTIVE = new Set(['activating', 'active']);
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^session-[a-zA-Z0-9][a-zA-Z0-9-]{6,62}$/;
const OP_ID = /^replace-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRESET_ID = /^dsh-replace-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CANDIDATE_CONFIG_LIMIT = 262_144;
const BASE_BINDING_LIMIT = 262_144;
const TASK_SNAPSHOT_LIMIT = 262_144;
const TASK_OUTCOMES = new Set(['transferred', 'completed', 'deleted', 'missing']);

/** Tools a born-Standby candidate may call before work activation. */
export const STANDBY_TOOLS = Object.freeze(['team_task_get', 'send_message']);
const STANDBY_BASE = new Set(STANDBY_TOOLS);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, keys) {
  return plainObject(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function jsonSnapshot(value, code, limit = TASK_SNAPSHOT_LIMIT) {
  let text;
  try {
    const seen = new Set();
    text = JSON.stringify(value, (_key, child) => {
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol'
        || typeof child === 'bigint' || (typeof child === 'number' && !Number.isFinite(child))) throw new Error(code);
      if (child && typeof child === 'object') {
        if (types.isProxy(child) || (!Array.isArray(child) && !plainObject(child)) || seen.has(child)) throw new Error(code);
        seen.add(child);
      }
      return child;
    });
  } catch { fail(code); }
  if (typeof text !== 'string' || text.length > limit) fail(code);
  try { return deepFreeze(JSON.parse(text)); } catch { fail(code); }
}

function validAt(value) { return Number.isInteger(value) && value >= 0; }

/** A replacement request is explicit configuration; nothing is substituted implicitly. */
export function parseReplacementRequest(raw) {
  if (!plainObject(raw) || types.isProxy(raw)) fail('REPLACEMENT_REQUEST_INVALID');
  const keys = new Set(Reflect.ownKeys(raw));
  const allowed = new Set(['role', 'provider', 'model', 'reasoningEffort', 'personaPrompt', 'prompt', 'tools',
    'progressFacts', 'expectedOldChildId']);
  for (const key of keys) if (!allowed.has(key)) fail('REPLACEMENT_REQUEST_INVALID');
  const role = raw.role, provider = raw.provider, model = raw.model, effort = raw.reasoningEffort;
  const persona = raw.personaPrompt, prompt = raw.prompt, tools = raw.tools;
  if (typeof role !== 'string' || !ROLE.test(role) || role === 'lead') fail('REPLACEMENT_ROLE_INVALID');
  if (typeof provider !== 'string' || provider.trim() !== provider || !provider
    || typeof model !== 'string' || model.trim() !== model || !model) fail('REPLACEMENT_ROUTE_INVALID');
  if (effort !== undefined && (typeof effort !== 'string' || effort.trim() === '' || effort.trim() !== effort
    || effort.length > 200 || !/^[\w.-]+$/.test(effort))) fail('REPLACEMENT_EFFORT_INVALID');
  if (typeof persona !== 'string' || persona.length > 16384 || !persona.trim() || persona.includes('\0')) fail('REPLACEMENT_PERSONA_INVALID');
  if (typeof prompt !== 'string' || prompt.length > 8000 || !prompt.trim() || prompt.includes('\0')) fail('REPLACEMENT_PROMPT_INVALID');
  if (tools !== undefined && !validRoleToolList(tools)) fail('REPLACEMENT_TOOLS_INVALID');
  if (raw.progressFacts !== undefined && (typeof raw.progressFacts !== 'string'
    || raw.progressFacts.length > 6000 || !raw.progressFacts.trim() || raw.progressFacts.includes('\0'))) {
    fail('REPLACEMENT_REQUEST_INVALID');
  }
  if (raw.expectedOldChildId !== undefined
    && (typeof raw.expectedOldChildId !== 'string' || !ID.test(raw.expectedOldChildId))) {
    fail('REPLACEMENT_CHILD_INVALID');
  }
  const allowlist = tools !== undefined ? [...tools] : [...COLLABORATION_TOOLS];
  return deepFreeze({ role, provider, model, reasoningEffort: effort ?? 'max', personaPrompt: persona,
    prompt, tools: allowlist, progressFacts: raw.progressFacts ?? 'No prior progress facts were supplied.',
    ...(raw.expectedOldChildId === undefined ? {} : { expectedOldChildId: raw.expectedOldChildId }) });
}

function parseTaskRef(raw) {
  if (!plainObject(raw)) fail('REPLACEMENT_RECORD_INVALID');
  const legacy = exactKeys(raw, ['taskId', 'revision']);
  if (!legacy && !exactKeys(raw, ['taskId', 'revision', 'snapshot'])) fail('REPLACEMENT_RECORD_INVALID');
  if (typeof raw.taskId !== 'string' || !raw.taskId || !Number.isInteger(raw.revision) || raw.revision < 1) {
    fail('REPLACEMENT_RECORD_INVALID');
  }
  if (legacy) return deepFreeze({ taskId: raw.taskId, revision: raw.revision });
  const snapshot = jsonSnapshot(raw.snapshot, 'REPLACEMENT_RECORD_INVALID');
  if (!plainObject(snapshot) || snapshot.id !== raw.taskId || snapshot.revision !== raw.revision
    || typeof snapshot.status !== 'string' || typeof snapshot.subject !== 'string') fail('REPLACEMENT_RECORD_INVALID');
  return deepFreeze({ taskId: raw.taskId, revision: raw.revision, snapshot });
}

function parseReadinessAck(raw, operation) {
  if (!exactKeys(raw, ['senderSessionId', 'handoffDigest', 'configDigest', 'at'])
    || raw.senderSessionId !== operation.newChildId || raw.handoffDigest !== operation.handoffDigest
    || raw.configDigest !== operation.configDigest || !validAt(raw.at)) fail('REPLACEMENT_ACK_INVALID');
  return deepFreeze(structuredClone(raw));
}

function parseWriteAttempt(raw, refs) {
  if (!exactKeys(raw, ['taskId', 'expectedRevision', 'at']) || !validAt(raw.at)
    || !Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 1) fail('REPLACEMENT_RECORD_INVALID');
  const ref = refs.find(entry => entry.taskId === raw.taskId);
  if (!ref || ref.revision !== raw.expectedRevision) fail('REPLACEMENT_RECORD_INVALID');
  return deepFreeze(structuredClone(raw));
}

function parseTaskOutcome(raw, refs) {
  const missing = raw?.kind === 'missing';
  if (!exactKeys(raw, missing ? ['taskId', 'kind', 'revision', 'at'] : ['taskId', 'kind', 'revision', 'at'])
    || !TASK_OUTCOMES.has(raw.kind) || !validAt(raw.at)) fail('REPLACEMENT_RECORD_INVALID');
  if (!refs.some(entry => entry.taskId === raw.taskId)) fail('REPLACEMENT_RECORD_INVALID');
  if (missing ? raw.revision !== null : (!Number.isInteger(raw.revision) || raw.revision < 1)) {
    fail('REPLACEMENT_RECORD_INVALID');
  }
  return deepFreeze(structuredClone(raw));
}

function parseTakeoverProof(raw, operation) {
  if (raw?.kind === 'not-required') {
    if (!exactKeys(raw, ['kind', 'reason', 'at']) || raw.reason !== 'no-unfinished-tasks' || !validAt(raw.at)
      || operation.taskOutcomes.some(entry => entry.kind === 'transferred')) fail('REPLACEMENT_PROOF_INVALID');
    return deepFreeze(structuredClone(raw));
  }
  if (!exactKeys(raw, ['kind', 'success', 'childId', 'operationId', 'handoffDigest', 'taskId',
    'expectedRevision', 'revision', 'callId', 'callSeq', 'resultSeq', 'action', 'at'])
    || raw.kind !== 'task-write' || raw.success !== true || raw.childId !== operation.newChildId
    || raw.operationId !== operation.id
    || raw.handoffDigest !== operation.handoffDigest || !validAt(raw.at)
    || !Number.isInteger(raw.expectedRevision) || !Number.isInteger(raw.revision)
    || raw.revision !== raw.expectedRevision + 1 || typeof raw.callId !== 'string' || !raw.callId
    || raw.callId.length > 256 || !Number.isSafeInteger(raw.callSeq) || raw.callSeq < 0
    || !Number.isSafeInteger(raw.resultSeq) || raw.resultSeq <= raw.callSeq
    || !['claim', 'edit', 'complete'].includes(raw.action)) {
    fail('REPLACEMENT_PROOF_INVALID');
  }
  const outcome = operation.taskOutcomes.find(entry => entry.taskId === raw.taskId && entry.kind === 'transferred');
  if (!outcome || raw.expectedRevision < outcome.revision) fail('REPLACEMENT_PROOF_INVALID');
  return deepFreeze(structuredClone(raw));
}

function parseOperation(raw, at) {
  if (!plainObject(raw)) fail('REPLACEMENT_RECORD_INVALID');
  const allowed = new Set(['id', 'role', 'oldChildId', 'newChildId', 'handoffDigest', 'taskRefs', 'phase', 'phases',
    'createdAt', 'handoffText', 'candidateConfig', 'instanceName', 'presetId', 'configDigest', 'readinessAck',
    'ownerWriteAttempts', 'taskOutcomes', 'takeoverProof']);
  for (const key of Reflect.ownKeys(raw)) if (!allowed.has(key)) fail('REPLACEMENT_RECORD_INVALID');
  if (typeof raw.id !== 'string' || !OP_ID.test(raw.id) || typeof raw.role !== 'string' || !ROLE.test(raw.role)
    || typeof raw.oldChildId !== 'string' || !ID.test(raw.oldChildId)
    || (raw.newChildId !== null && (typeof raw.newChildId !== 'string' || !ID.test(raw.newChildId)))
    || typeof raw.handoffDigest !== 'string' || !HEX64.test(raw.handoffDigest)) fail('REPLACEMENT_RECORD_INVALID');
  if (raw.handoffText !== undefined && (typeof raw.handoffText !== 'string' || raw.handoffText.length > 131_072)) {
    fail('REPLACEMENT_RECORD_INVALID');
  }
  const taskRefs = Array.isArray(raw.taskRefs) ? raw.taskRefs.map(parseTaskRef) : fail('REPLACEMENT_RECORD_INVALID');
  if (new Set(taskRefs.map(ref => ref.taskId)).size !== taskRefs.length) fail('REPLACEMENT_RECORD_INVALID');
  if (!REPLACEMENT_PHASES.includes(raw.phase) || !Array.isArray(raw.phases) || raw.phases.length === 0
    || raw.phases.some(entry => !exactKeys(entry, ['phase', 'at']) || !REPLACEMENT_PHASES.includes(entry.phase)
      || !validAt(entry.at)) || raw.phases.at(-1).phase !== raw.phase
    || !validAt(raw.createdAt) || raw.createdAt > at) fail('REPLACEMENT_RECORD_INVALID');
  if (['standby', 'ready', 'transferring', 'activating', 'active', 'recovering'].includes(raw.phase)
    && raw.newChildId === null) fail('REPLACEMENT_RECORD_INVALID');

  const planned = raw.candidateConfig !== undefined;
  if (planned) {
    if (typeof raw.candidateConfig !== 'string' || raw.candidateConfig.length > CANDIDATE_CONFIG_LIMIT
      || typeof raw.instanceName !== 'string' || !raw.instanceName.trim() || raw.instanceName !== raw.instanceName.trim()
      || raw.instanceName.length > 128 || typeof raw.presetId !== 'string' || !PRESET_ID.test(raw.presetId)
      || typeof raw.configDigest !== 'string' || !HEX64.test(raw.configDigest)
      || createHash('sha256').update(raw.candidateConfig).digest('hex') !== raw.configDigest) fail('REPLACEMENT_RECORD_INVALID');
    const candidate = replacementCandidateOf(raw);
    if (candidate.request.role !== raw.role
      || (raw.newChildId !== null && raw.newChildId !== candidate.childId)) fail('REPLACEMENT_RECORD_INVALID');
  } else if (raw.instanceName !== undefined || raw.configDigest !== undefined
    || (raw.presetId !== undefined && !PRESET_ID.test(raw.presetId))) fail('REPLACEMENT_RECORD_INVALID');

  if (raw.ownerWriteAttempts !== undefined && !Array.isArray(raw.ownerWriteAttempts)) fail('REPLACEMENT_RECORD_INVALID');
  if (raw.taskOutcomes !== undefined && !Array.isArray(raw.taskOutcomes)) fail('REPLACEMENT_RECORD_INVALID');
  const operation = { ...structuredClone(raw), taskRefs,
    readinessAck: raw.readinessAck ?? null,
    ownerWriteAttempts: raw.ownerWriteAttempts ?? [], taskOutcomes: raw.taskOutcomes ?? [],
    takeoverProof: raw.takeoverProof ?? null };
  operation.ownerWriteAttempts = operation.ownerWriteAttempts.map(entry => parseWriteAttempt(entry, taskRefs));
  operation.taskOutcomes = operation.taskOutcomes.map(entry => parseTaskOutcome(entry, taskRefs));
  if (new Set(operation.taskOutcomes.map(entry => entry.taskId)).size !== operation.taskOutcomes.length) {
    fail('REPLACEMENT_RECORD_INVALID');
  }
  if (operation.readinessAck !== null) operation.readinessAck = parseReadinessAck(operation.readinessAck, operation);
  if (operation.takeoverProof !== null) operation.takeoverProof = parseTakeoverProof(operation.takeoverProof, operation);
  if (planned && ['ready', 'transferring', 'activating', 'active'].includes(operation.phase)
    && operation.readinessAck === null) fail('REPLACEMENT_ACK_INVALID');
  if (planned && operation.phase === 'active' && operation.takeoverProof === null) fail('REPLACEMENT_PROOF_INVALID');
  return deepFreeze(operation);
}

function validateBaseBinding(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > BASE_BINDING_LIMIT) {
    fail('REPLACEMENT_BASE_BINDING_INVALID');
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('REPLACEMENT_BASE_BINDING_INVALID'); }
  if (!exactKeys(parsed, ['workspace', 'template']) || typeof parsed.workspace !== 'string'
    || !parsed.workspace.trim() || parsed.workspace !== parsed.workspace.trim()
    || parsed.workspace.length > 32_768 || parsed.workspace.includes('\0') || !plainObject(parsed.template)) {
    fail('REPLACEMENT_BASE_BINDING_INVALID');
  }
  // Parse already guarantees JSON-only content; snapshot validation also rejects
  // pathological depth/prototypes before this immutable configuration is trusted.
  jsonSnapshot(parsed, 'REPLACEMENT_BASE_BINDING_INVALID', BASE_BINDING_LIMIT);
  return value;
}

/** Validate a stored record value; undefined is an uninitialized root partition. */
export function readReplacementRecord(value, at = Date.now()) {
  if (value === undefined || value === null) return deepFreeze({ version: REPLACEMENT_RECORD_VERSION, operations: [] });
  const keys = Object.hasOwn(value ?? {}, 'baseBinding')
    ? ['version', 'baseBinding', 'operations'] : ['version', 'operations'];
  if (!plainObject(value) || types.isProxy(value) || !exactKeys(value, keys)
    || value.version !== REPLACEMENT_RECORD_VERSION || !Array.isArray(value.operations)) fail('REPLACEMENT_RECORD_INVALID');
  const baseBinding = value.baseBinding === undefined ? undefined : validateBaseBinding(value.baseBinding);
  const operations = value.operations.map(raw => parseOperation(raw, at));
  const seen = new Set(), owners = new Map(), live = new Set();
  for (const operation of operations) {
    if (seen.has(operation.id) || live.has(operation.role)) fail('REPLACEMENT_RECORD_INVALID');
    seen.add(operation.id);
    const previous = owners.get(operation.role);
    if (previous !== undefined && previous !== operation.oldChildId) fail('REPLACEMENT_OLD_MEMBER_MISMATCH');
    if (previous === undefined) owners.set(operation.role, operation.oldChildId);
    if (operation.phase === 'active') owners.set(operation.role, operation.newChildId);
    else if (operation.phase !== 'aborted') live.add(operation.role);
  }
  return deepFreeze({ version: REPLACEMENT_RECORD_VERSION,
    ...(baseBinding === undefined ? {} : { baseBinding }), operations });
}

function withOperations(record, operations) {
  return readReplacementRecord({ version: REPLACEMENT_RECORD_VERSION,
    ...(record.baseBinding === undefined ? {} : { baseBinding: record.baseBinding }), operations });
}

/** Bind the root's original current-team template once. It is immutable configuration,
 * not another lifecycle state source. */
export function ensureReplacementBaseBinding(record, baseBinding) {
  const validated = validateBaseBinding(baseBinding);
  if (record.baseBinding !== undefined) {
    if (record.baseBinding !== validated) fail('REPLACEMENT_BASE_BINDING_MISMATCH');
    return record;
  }
  return readReplacementRecord({ version: REPLACEMENT_RECORD_VERSION, baseBinding: validated,
    operations: record.operations });
}

/** The durable current child for a logical role, including across reload and repeated replacement. */
export function currentRoleOwner(record, role) {
  if (typeof role !== 'string' || !ROLE.test(role)) fail('REPLACEMENT_ROLE_INVALID');
  let owner;
  for (const operation of record.operations) {
    if (operation.role !== role) continue;
    if (owner === undefined) owner = operation.oldChildId;
    if (operation.phase === 'active') owner = operation.newChildId;
  }
  return owner;
}

function reservedChildId(operationId) {
  return `session-${operationId.slice('replace-'.length)}`;
}

/** Decode the immutable native activation coordinates stored before spawn. */
export function replacementCandidateOf(operation) {
  if (!plainObject(operation) || typeof operation.candidateConfig !== 'string'
    || operation.candidateConfig.length > CANDIDATE_CONFIG_LIMIT) fail('REPLACEMENT_CONFIG_INVALID');
  let raw;
  try { raw = JSON.parse(operation.candidateConfig); } catch { fail('REPLACEMENT_CONFIG_INVALID'); }
  if (!plainObject(raw) || typeof raw.agentPreset !== 'string' || !PRESET_ID.test(raw.agentPreset)
    || typeof raw.childId !== 'string' || !ID.test(raw.childId)) fail('REPLACEMENT_CONFIG_INVALID');
  const requestRaw = { ...raw };
  Reflect.deleteProperty(requestRaw, 'agentPreset');
  Reflect.deleteProperty(requestRaw, 'childId');
  const request = parseReplacementRequest(requestRaw);
  if (request.role !== operation.role || raw.agentPreset !== operation.presetId
    || raw.childId !== reservedChildId(operation.id)) fail('REPLACEMENT_CONFIG_INVALID');
  return deepFreeze({ request, agentPreset: raw.agentPreset, childId: raw.childId });
}

export function replacementRequestOf(operation) {
  return replacementCandidateOf(operation).request;
}

export function startReplacement(record, { role, oldChildId, handoffDigest, taskRefs,
  handoffText, candidateConfig, instanceName }, at = Date.now()) {
  if (typeof role !== 'string' || !ROLE.test(role) || role === 'lead'
    || typeof oldChildId !== 'string' || !ID.test(oldChildId)
    || typeof handoffDigest !== 'string' || !HEX64.test(handoffDigest)
    || (handoffText !== undefined && (typeof handoffText !== 'string' || handoffText.length > 131_072))) {
    fail('REPLACEMENT_HANDOFF_INVALID');
  }
  if (!Array.isArray(taskRefs)) fail('REPLACEMENT_HANDOFF_INVALID');
  const parsedRefs = taskRefs.map(raw => {
    try { return parseTaskRef(raw); } catch { fail('REPLACEMENT_HANDOFF_INVALID'); }
  });
  for (const operation of record.operations) {
    if (operation.role === role && operation.phase !== 'aborted' && operation.phase !== 'active') fail('REPLACEMENT_ROLE_BUSY');
  }
  const mapped = currentRoleOwner(record, role);
  if (mapped !== undefined && mapped !== oldChildId) fail('REPLACEMENT_OLD_MEMBER_MISMATCH');
  const id = `replace-${randomUUID()}`, presetId = `dsh-${id}`, childId = reservedChildId(id);
  let configDigest;
  if (candidateConfig !== undefined) {
    if (typeof candidateConfig !== 'string' || candidateConfig.length > CANDIDATE_CONFIG_LIMIT
      || typeof instanceName !== 'string' || !instanceName.trim() || instanceName !== instanceName.trim()
      || instanceName.length > 128) fail('REPLACEMENT_CONFIG_INVALID');
    let raw;
    try { raw = JSON.parse(candidateConfig); } catch { fail('REPLACEMENT_CONFIG_INVALID'); }
    const request = parseReplacementRequest(raw);
    if (request.role !== role || (request.expectedOldChildId !== undefined
      && request.expectedOldChildId !== oldChildId)) fail('REPLACEMENT_CONFIG_INVALID');
    candidateConfig = JSON.stringify({ ...request, agentPreset: presetId, childId });
    if (candidateConfig.length > CANDIDATE_CONFIG_LIMIT) fail('REPLACEMENT_CONFIG_INVALID');
    configDigest = createHash('sha256').update(candidateConfig).digest('hex');
  }
  const operation = { id, role, oldChildId, newChildId: null, handoffDigest,
    taskRefs: parsedRefs.map(ref => structuredClone(ref)), phase: 'frozen',
    ...(handoffText !== undefined ? { handoffText } : {}),
    ...(candidateConfig !== undefined ? { candidateConfig, instanceName, presetId, configDigest } : {}),
    readinessAck: null, ownerWriteAttempts: [], taskOutcomes: [], takeoverProof: null,
    phases: [{ phase: 'frozen', at }], createdAt: at };
  return { record: withOperations(record, [...record.operations, operation]), operationId: id };
}

const ALLOWED_TRANSITIONS = new Map([
  ['frozen', new Set(['standby', 'cancelling', 'aborted'])],
  ['standby', new Set(['ready', 'cancelling', 'aborted'])],
  ['ready', new Set(['transferring', 'cancelling', 'aborted'])],
  ['transferring', new Set(['activating', 'active', 'recovering', 'cancelling'])],
  ['recovering', new Set(['transferring', 'activating', 'active'])],
  ['activating', new Set(['active', 'recovering'])],
  ['cancelling', new Set(['aborted'])],
  ['active', new Set()],
  ['aborted', new Set()],
]);

/** Phase transitions are explicit. Planned operations require real ACK/transfer/proof evidence;
 * legacy admission fixtures without candidateConfig may still construct phase projections. */
export function transitionReplacement(record, operationId, phase, at = Date.now(), extra = {}) {
  const operation = record.operations.find(entry => entry.id === operationId);
  if (!operation) fail('REPLACEMENT_OPERATION_NOT_FOUND');
  if (!ALLOWED_TRANSITIONS.get(operation.phase)?.has(phase)) fail('REPLACEMENT_TRANSITION_INVALID');
  if (!plainObject(extra) || Reflect.ownKeys(extra).some(key => !['newChildId', 'readinessAck', 'takeoverProof'].includes(key))) {
    fail('REPLACEMENT_TRANSITION_INVALID');
  }
  if (phase === 'cancelling' && operation.ownerWriteAttempts.length) fail('REPLACEMENT_TRANSITION_INVALID');
  const planned = operation.candidateConfig !== undefined;
  if (planned && phase === 'standby'
    && extra.newChildId !== replacementCandidateOf(operation).childId) fail('REPLACEMENT_CHILD_CHANGED');
  if (planned && phase === 'aborted' && operation.phase !== 'cancelling') fail('REPLACEMENT_TRANSITION_INVALID');
  if (planned && phase === 'ready' && extra.readinessAck === undefined) fail('REPLACEMENT_ACK_INVALID');
  if (planned && phase === 'activating') {
    if (operation.taskRefs.some(ref => !operation.taskOutcomes.some(outcome => outcome.taskId === ref.taskId))) {
      fail('REPLACEMENT_TRANSFER_INCOMPLETE');
    }
  }
  if (planned && phase === 'active' && (operation.phase !== 'activating' || extra.takeoverProof === undefined)) {
    fail('REPLACEMENT_PROOF_INVALID');
  }
  const next = { ...structuredClone(operation), phase, phases: [...operation.phases, { phase, at }],
    ...(extra.newChildId !== undefined ? { newChildId: extra.newChildId } : {}),
    ...(extra.readinessAck !== undefined ? { readinessAck: extra.readinessAck } : {}),
    ...(extra.takeoverProof !== undefined ? { takeoverProof: extra.takeoverProof } : {}) };
  return withOperations(record, record.operations.map(entry => entry.id === operationId ? next : entry));
}

export function cancelReplacement(record, operationId, at = Date.now()) {
  return transitionReplacement(record, operationId, 'aborted', at);
}

export function recordOwnerWriteAttempt(record, operationId, taskId, expectedRevision, at = Date.now()) {
  const operation = record.operations.find(entry => entry.id === operationId);
  if (!operation || !['transferring', 'recovering'].includes(operation.phase)
    || !operation.taskRefs.some(ref => ref.taskId === taskId && ref.revision === expectedRevision)) {
    fail('REPLACEMENT_TRANSFER_INVALID');
  }
  const next = { ...structuredClone(operation), ownerWriteAttempts: [...operation.ownerWriteAttempts,
    { taskId, expectedRevision, at }] };
  return withOperations(record, record.operations.map(entry => entry.id === operationId ? next : entry));
}

export function recordTaskOutcome(record, operationId, outcome, at = Date.now()) {
  const operation = record.operations.find(entry => entry.id === operationId);
  if (!operation || !['transferring', 'recovering'].includes(operation.phase) || !plainObject(outcome)
    || !exactKeys(outcome, ['taskId', 'kind', 'revision']) || !TASK_OUTCOMES.has(outcome.kind)
    || !operation.taskRefs.some(ref => ref.taskId === outcome.taskId)
    || (outcome.kind === 'missing' ? outcome.revision !== null
      : (!Number.isInteger(outcome.revision) || outcome.revision < 1))) fail('REPLACEMENT_TRANSFER_INVALID');
  if (outcome.kind === 'transferred' && !operation.ownerWriteAttempts.some(entry => entry.taskId === outcome.taskId)) {
    fail('REPLACEMENT_TRANSFER_INVALID');
  }
  const evidence = { ...structuredClone(outcome), at };
  const taskOutcomes = operation.taskOutcomes.some(entry => entry.taskId === outcome.taskId)
    ? operation.taskOutcomes.map(entry => entry.taskId === outcome.taskId ? evidence : entry)
    : [...operation.taskOutcomes, evidence];
  const next = { ...structuredClone(operation), taskOutcomes };
  return withOperations(record, record.operations.map(entry => entry.id === operationId ? next : entry));
}

/** Current execution eligibility of one child session, derived only from the durable record. */
export function eligibilityOf(record, childId) {
  if (typeof childId !== 'string' || !ID.test(childId)) fail('REPLACEMENT_CHILD_INVALID');
  let result = { kind: 'full', operationId: null };
  for (const operation of record.operations) {
    if (operation.oldChildId === childId && OLD_FROZEN.has(operation.phase)) {
      return { kind: 'none', operationId: operation.id, reason: 'TEAM_MEMBER_RETIRED' };
    }
    if (operation.newChildId !== childId) continue;
    if (operation.phase === 'cancelling' || operation.phase === 'aborted') {
      result = { kind: 'none', operationId: operation.id, reason: 'TEAM_REPLACEMENT_CANCELLED' };
    } else if (CANDIDATE_ACTIVE.has(operation.phase)) result = { kind: 'full', operationId: operation.id };
    else if (CANDIDATE_STANDBY.has(operation.phase)) result = { kind: 'standby', operationId: operation.id };
  }
  return result;
}

/** A born candidate is Standby before child binding, but cancellation denies it immediately. */
export function candidateEligibility(record, operationId, childId) {
  const operation = record.operations.find(entry => entry.id === operationId);
  if (!operation) return { kind: 'standby', operationId, reason: 'TEAM_CANDIDATE_UNBOUND' };
  if (operation.phase === 'cancelling' || operation.phase === 'aborted') {
    return { kind: 'none', operationId, reason: 'TEAM_REPLACEMENT_CANCELLED' };
  }
  if (operation.newChildId === null) return { kind: 'standby', operationId, reason: 'TEAM_CANDIDATE_UNBOUND' };
  if (operation.newChildId !== childId) return { kind: 'none', operationId, reason: 'TEAM_CANDIDATE_UNBOUND' };
  return eligibilityOf(record, childId);
}

export function admissionAllowlist(eligibility, configuredTools) {
  if (eligibility.kind === 'none') return Object.freeze([]);
  if (eligibility.kind === 'standby') return STANDBY_TOOLS;
  const allowed = new Set(configuredTools);
  for (const name of COLLABORATION_TOOLS) allowed.add(name);
  return Object.freeze([...allowed].filter(name => selectableRoleTool(name) || COLLABORATION_TOOLS.includes(name)));
}

/** Immutable handoff snapshot preserves the complete JSON task view used for transfer checks. */
export function buildHandoffSnapshot({ role, tasks, progress }) {
  if (typeof role !== 'string' || !ROLE.test(role) || role === 'lead' || !Array.isArray(tasks)) {
    fail('REPLACEMENT_HANDOFF_INVALID');
  }
  const snapshots = tasks.map(task => {
    const value = jsonSnapshot(task, 'REPLACEMENT_HANDOFF_INVALID');
    if (!plainObject(value) || typeof value.id !== 'string' || !value.id || !Number.isInteger(value.revision)
      || value.revision < 1 || typeof value.status !== 'string' || typeof value.subject !== 'string') {
      fail('REPLACEMENT_HANDOFF_INVALID');
    }
    return value;
  });
  if (new Set(snapshots.map(task => task.id)).size !== snapshots.length
    || typeof progress !== 'string' || progress.length > 6000 || !progress.trim() || progress.includes('\0')) {
    fail('REPLACEMENT_HANDOFF_INVALID');
  }
  const payload = JSON.stringify({ role, tasks: snapshots, progress });
  const handoffDigest = createHash('sha256').update(payload).digest('hex');
  const taskRefs = snapshots.map(task => deepFreeze({ taskId: task.id, revision: task.revision, snapshot: task }));
  return deepFreeze({ taskRefs, handoffDigest,
    text: `Replacement handoff for role "${role}". Snapshot digest ${handoffDigest}.\n`
      + `Tasks (id @ revision, status): ${snapshots.map(task => `${task.id} @${task.revision} ${task.status} — ${task.subject}`).join('; ')
        || 'none'}\nProgress facts from the previous member:\n${progress}` });
}

/** Strict ACK: the transport must supply the actual sender and exact JSON body. */
export function verifyReadinessAck({ text, senderSessionId, operation, at = Date.now() }) {
  if (typeof text !== 'string' || typeof senderSessionId !== 'string' || !plainObject(operation)) fail('REPLACEMENT_ACK_INVALID');
  if (senderSessionId !== operation.newChildId) return { ok: false, reason: 'TEAM_ACK_WRONG_SENDER' };
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, reason: 'TEAM_ACK_INVALID_JSON' }; }
  const keys = operation.configDigest === undefined
    ? ['ready', 'operation', 'handoff'] : ['ready', 'operation', 'handoff', 'config'];
  if (!exactKeys(body, keys)) return { ok: false, reason: 'TEAM_ACK_INVALID_SHAPE' };
  if (body.ready !== true) return { ok: false, reason: 'TEAM_ACK_NOT_READY' };
  if (body.operation !== operation.id || body.handoff !== operation.handoffDigest
    || (operation.configDigest !== undefined && body.config !== operation.configDigest)) {
    return { ok: false, reason: 'TEAM_ACK_VERSION_MISMATCH' };
  }
  return { ok: true, evidence: deepFreeze({ senderSessionId, handoffDigest: operation.handoffDigest,
    configDigest: operation.configDigest, at }) };
}

export function verifyTakeoverProof({ proof, operation, at = Date.now() }) {
  if (!plainObject(operation) || !plainObject(proof)
    || !exactKeys(proof, ['childId', 'operationId', 'handoffDigest', 'taskId', 'expectedRevision',
      'revision', 'callId', 'callSeq', 'resultSeq', 'action', 'success'])
    || proof.success !== true || proof.childId !== operation.newChildId || proof.operationId !== operation.id
    || proof.handoffDigest !== operation.handoffDigest || !Number.isInteger(proof.expectedRevision)
    || !Number.isInteger(proof.revision) || proof.revision !== proof.expectedRevision + 1
    || typeof proof.callId !== 'string' || !proof.callId || proof.callId.length > 256
    || !Number.isSafeInteger(proof.callSeq) || proof.callSeq < 0
    || !Number.isSafeInteger(proof.resultSeq) || proof.resultSeq <= proof.callSeq
    || !['claim', 'edit', 'complete'].includes(proof.action)) {
    return { ok: false, reason: 'REPLACEMENT_PROOF_INVALID' };
  }
  const outcome = operation.taskOutcomes?.find(entry => entry.taskId === proof.taskId && entry.kind === 'transferred');
  // The transfer revision is the lower ownership fence. Lead edits may advance
  // the same candidate-owned task before the candidate's successful CAS.
  if (!outcome || proof.expectedRevision < outcome.revision) return { ok: false, reason: 'REPLACEMENT_PROOF_INVALID' };
  return { ok: true, evidence: deepFreeze({ kind: 'task-write', success: true, childId: proof.childId,
    operationId: proof.operationId, handoffDigest: proof.handoffDigest, taskId: proof.taskId,
    expectedRevision: proof.expectedRevision, revision: proof.revision, callId: proof.callId,
    callSeq: proof.callSeq, resultSeq: proof.resultSeq, action: proof.action, at }) };
}

export const STANDBY_TOOL_SET = STANDBY_BASE;
