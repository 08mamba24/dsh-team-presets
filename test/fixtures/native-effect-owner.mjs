// Bounded Cordis ownership model, not the framework implementation.
// Pinned source: @deepseek-ai/cordis 4.1.0 in ASAR SHA256
// 1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d.
// src/events.ts:263-269; src/utils.ts:27-30; src/fiber.ts:424-458,510-526,712-730.
// Models only synchronous effect setup, yielded ownership transfer, joined
// disposers, serial group cleanup and parallel top-level owner teardown.
// Omits service dependency/reload, effect diagnostics and setup-failure rollback.
export function nativeEffectOwner() {
  const top = new Set();
  const inFlight = new WeakMap();
  let unloading = false, unloadTask;
  const runDisposable = release => {
    const result = release();
    return inFlight.get(release) ?? result;
  };
  function effect(execute) {
    if (unloading) throw Object.assign(new Error('INACTIVE_EFFECT'), { code: 'INACTIVE_EFFECT' });
    const resources = [];
    let disposing = false;
    const dispose = () => {
      // Native public wrapper calls are single-shot; only the owner's
      // runDisposable(effectInertia) joins a teardown already in flight.
      if (disposing) return;
      disposing = true;
      let task;
      for (const release of resources.splice(0).reverse()) {
        if (task) task = task.then(() => runDisposable(release));
        else {
          const result = runDisposable(release);
          if (result && typeof result.then === 'function') task = Promise.resolve(result);
        }
      }
      if (task) {
        const pending = task.finally(() => { top.delete(dispose); inFlight.delete(dispose); });
        inFlight.set(dispose, pending);
        return pending;
      }
      top.delete(dispose);
    };
    // Cordis registers the wrapper before running effect setup.
    top.add(dispose);
    const collect = release => {
      if (release === undefined || release === null) return;
      if (typeof release !== 'function') throw new TypeError('Invalid effect');
      resources.push(release);
      top.delete(release); // Yielded effect wrappers become structural children.
    };
    const result = execute();
    if (typeof result === 'function') collect(result);
    else if (result != null) {
      if (typeof result[Symbol.iterator] !== 'function') throw new TypeError('Unsupported fixture setup');
      for (const release of result) collect(release);
    }
    return dispose;
  }
  function on(hooks, name, callback) {
    return effect(() => {
      if (!hooks.has(name)) hooks.set(name, new Set());
      hooks.get(name).add(callback);
      return () => hooks.get(name).delete(callback);
    });
  }
  function dispose() {
    if (!unloadTask) {
      unloading = true;
      const captured = [...top].reverse(); top.clear();
      // Native fiber._unload schedules every sibling, rather than serially
      // awaiting a drain effect before removing automatically owned listeners.
      unloadTask = Promise.all(captured.map(async release => {
        await Promise.resolve();
        await runDisposable(release);
      })).then(() => {});
    }
    return unloadTask;
  }
  return { effect, on, dispose, topCount: () => top.size };
}
