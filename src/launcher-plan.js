// Pure reconciliation over an explicit template and an independently observed native catalog.
// No Host access, persistence, member creation, messaging, or default inference happens here.

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SCALARS = ['description', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'personaPrompt'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const name = value => typeof value === 'string' && NAME.test(value) && value !== 'lead';
const identity = value => record(value) && name(value.name) && typeof value.id === 'string' && ID.test(value.id);
const tools = value => Array.isArray(value) && value.every(item => text(item) && item.trim() === item);

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function conflict(spec, observed, unverifiableFields = ['catalogMembership']) {
  return {
    name: spec.name,
    action: 'conflict',
    ...(observed ? { childId: observed.id } : {}),
    driftFields: [],
    unverifiableFields,
  };
}

/**
 * Plan direct members from a normalized dsh-team-template/1 and an explicit observation.
 * observation.complete means a complete native catalog, never an empty live-Agent registry.
 * Each observed member is { id, name, description?, agentPreset?, provider?, model?,
 * reasoningEffort?, personaPrompt?, nativeToolAllowlist? }. description must come from the
 * actual native catalog label. A preset ID, receipt, fingerprint or default is not evidence
 * of the live persona or tools; those values must be independently observable and equal.
 * Missing intended persona/tool configuration is also insufficient to prove reuse.
 *
 * spec.prompt is one-time startup input for CREATE only. It is deliberately not compared
 * with current personaPrompt, and REUSE never resends it or changes the persistent persona.
 * This function returns a plan only; even CREATE does not authorize an execution adapter.
 * Foreign members are returned as detached identities and remain untouched.
 */
export function planLauncherMembers(normalizedTemplate, observation) {
  const reasons = [];
  const specs = normalizedTemplate?.members;
  if (!record(normalizedTemplate) || normalizedTemplate.templateSchema !== 'dsh-team-template/1'
    || !Array.isArray(specs) || specs.length === 0
    || specs.some(member => !record(member) || !name(member.name)
      || !['description', 'prompt', 'provider', 'model'].every(key => text(member[key])))
    || new Set(specs.map(member => member.name)).size !== specs.length) {
    return freeze({ blocked: true, members: [], foreignMembers: [], reasons: ['INVALID_NORMALIZED_TEMPLATE'] });
  }
  const entries = record(observation) && Array.isArray(observation.members) ? observation.members : [];
  if (!record(observation) || observation.complete !== true) reasons.push('NATIVE_CATALOG_INCOMPLETE');
  if (!record(observation) || !Array.isArray(observation.members)) reasons.push('NATIVE_CATALOG_MEMBERS_INVALID');
  const byName = new Map(), ids = new Set();
  entries.forEach((member, index) => {
    if (!identity(member)) {
      reasons.push(`INVALID_MEMBER_IDENTITY:${index}`);
      return;
    }
    if (byName.has(member.name)) reasons.push(`DUPLICATE_MEMBER_NAME:${member.name}`);
    if (ids.has(member.id)) reasons.push(`DUPLICATE_MEMBER_ID:${member.id}`);
    byName.set(member.name, [...(byName.get(member.name) ?? []), member]);
    ids.add(member.id);
  });
  const catalogTrusted = reasons.length === 0;
  const wanted = new Set(specs.map(member => member.name));
  const foreignMembers = entries.filter(member => identity(member) && !wanted.has(member.name))
    .map(member => ({ id: member.id, name: member.name }));
  const members = specs.map(spec => {
    const matches = byName.get(spec.name) ?? [];
    if (!catalogTrusted) return conflict(spec, matches.length === 1 ? matches[0] : undefined);
    if (matches.length === 0) return { name: spec.name, action: 'create', driftFields: [], unverifiableFields: [] };
    const observed = matches[0], driftFields = [], unverifiableFields = [];
    for (const key of SCALARS) {
      // Persona remains a required equivalence proof even when a template omitted its intent.
      if (!Object.hasOwn(spec, key) && key !== 'personaPrompt') continue;
      if (!text(spec[key]) || !text(observed[key])) unverifiableFields.push(key);
      else if (spec[key] !== observed[key]) driftFields.push(key);
    }
    if (!tools(spec.nativeToolAllowlist) || !tools(observed.nativeToolAllowlist)) {
      unverifiableFields.push('nativeToolAllowlist');
    } else {
      const expected = new Set(spec.nativeToolAllowlist), actual = new Set(observed.nativeToolAllowlist);
      if (expected.size !== actual.size || [...expected].some(tool => !actual.has(tool))) driftFields.push('nativeToolAllowlist');
    }
    const blocked = driftFields.length > 0 || unverifiableFields.length > 0;
    if (blocked) reasons.push(`MEMBER_CONFLICT:${spec.name}`);
    return { name: spec.name, action: blocked ? 'conflict' : 'reuse', childId: observed.id, driftFields, unverifiableFields };
  });
  return freeze({ blocked: reasons.length > 0, members, foreignMembers, reasons });
}
