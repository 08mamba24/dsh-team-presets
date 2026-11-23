import { fail } from './config.js';

const contexts = new WeakMap();
const contracts = new WeakSet();
const VERSIONS = new Set(['0.2.2-rc.2', '0.2.2-rc.5', '0.2.3-alpha.2']);

/** Select contracts from verified Host metadata, never from Session history. */
export function createHostAdapter({ version, Context }) {
  if (!VERSIONS.has(version)) fail('HOST_ADAPTER_VERSION_UNSUPPORTED');
  const live = version === '0.2.3-alpha.2';
  if (live && typeof Context?.root !== 'symbol') fail('HOST_ROOT_CONTRACT_UNAVAILABLE');
  const adapter = Object.freeze({
    version,
    rootContext(ctx) {
      const root = live ? ctx?.[Context.root] : ctx?.root;
      if (!root || typeof root.plugin !== 'function') fail('HOST_ROOT_CONTRACT_UNAVAILABLE');
      return root;
    },
    allowedRoutes(ctx, session) {
      let routes;
      try {
        if (live) {
          const service = ctx.get('subagentModelSelection');
          if (typeof service?.allowedRoutes !== 'function') fail('HOST_MODEL_POLICY_UNAVAILABLE');
          // Undefined means the live setting is disabled. It grants no route.
          routes = service.allowedRoutes();
        } else {
          routes = ctx.sessionProjections.stateOf(session, 'subagentModelSelectionPolicy');
        }
      } catch { fail('HOST_MODEL_POLICY_UNAVAILABLE'); }
      if (routes === undefined) return [];
      if (!Array.isArray(routes)) fail('HOST_MODEL_POLICY_UNAVAILABLE');
      const seen = new Set();
      return routes.map(route => {
        if (!route || typeof route.provider !== 'string' || route.provider.length === 0
          || typeof route.model !== 'string' || route.model.length === 0) fail('HOST_MODEL_POLICY_UNAVAILABLE');
        const key = `${route.provider}\0${route.model}`;
        if (live && seen.has(key)) fail('HOST_MODEL_POLICY_UNAVAILABLE');
        seen.add(key);
        return { provider: route.provider, model: route.model };
      });
    },
  });
  contracts.add(adapter);
  return adapter;
}

/** Bind once at a native entry, after the archive and module checks succeed. */
export function bindHostContext(ctx, adapter) {
  if (!ctx || typeof ctx !== 'object' || !contracts.has(adapter)) fail('HOST_ADAPTER_UNVERIFIABLE');
  const before = contexts.get(ctx);
  if (before !== undefined && before !== adapter) fail('HOST_ADAPTER_CHANGED');
  contexts.set(ctx, adapter);
}

export function readAuthorizedRoutes(ctx, session) {
  const adapter = contexts.get(ctx);
  if (adapter === undefined) fail('HOST_MODEL_POLICY_UNBOUND');
  return adapter.allowedRoutes(ctx, session);
}

/** Carry the verified contract into an explicitly owned child plugin context. */
export function inheritHostContext(parent, child) {
  const adapter = contexts.get(parent);
  if (adapter === undefined) fail('HOST_MODEL_POLICY_UNBOUND');
  bindHostContext(child, adapter);
}
