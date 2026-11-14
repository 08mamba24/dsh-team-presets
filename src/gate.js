import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, sameControls } from './config.js';

/** One ordinary stream for one lifecycle-correlated child; unrelated traffic passes untouched. */
export function createGate(config) {
  const causal = new AsyncLocalStorage();
  let childId, admissions = 0, usage, finish, failure;
  const denials = [], blocked = new Set();
  function reject(code, options) {
    denials.push({ code, sessionId: options.sessionId ?? null, purpose: options.purpose ?? null });
    if (code !== 'ROOT_QUARANTINED') failure ??= code;
    fail(code);
  }
  return Object.freeze({
    run: operation => causal.run(true, operation),
    inRun: () => causal.getStore() === true,
    blockChild: id => { blocked.add(id); },
    track(id) {
      if (typeof id !== 'string' || !id || childId !== undefined) fail('UNEXPECTED_CHILD');
      childId = id;
    },
    evidence: () => ({ childId, admissions, usage, finish, failure, denials: denials.map(x => ({ ...x })) }),
    async *hook(options, next) {
      if (options.sessionId === config.ownedSessionId) reject('ROOT_QUARANTINED', options);
      if (blocked.has(options.sessionId)) reject('UNEXPECTED_CHILD', options);
      if (options.sessionId !== childId || childId === undefined) {
        if (causal.getStore() === true) reject('UNATTRIBUTED_OWNED_REQUEST', options);
        yield* next(); return;
      }
      if (options.purpose !== undefined) reject('AUXILIARY_DISABLED', options);
      if (!sameControls(options, config.route)) reject('DISPATCH_CONTROLS_CHANGED', options);
      if (admissions !== 0) reject('REQUEST_ALLOWANCE_USED', options);
      admissions++;
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = structuredClone(chunk.usage);
        if (chunk.type === 'finish') finish = chunk.reason;
        yield chunk;
      }
    },
  });
}
