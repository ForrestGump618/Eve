// Tiny pub/sub event bus. Modules communicate through named events so that
// views never need to import each other (keeps the dependency graph acyclic).

const listeners = new Map();

/** Subscribe to an event. Returns an unsubscribe function. */
export function on(type, handler) {
  if (typeof handler !== 'function') return () => {};
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(handler);
  return () => off(type, handler);
}

export function once(type, handler) {
  const un = on(type, (payload) => {
    un();
    handler(payload);
  });
  return un;
}

export function off(type, handler) {
  const set = listeners.get(type);
  if (!set) return;
  set.delete(handler);
  if (!set.size) listeners.delete(type);
}

/** Emit an event to all subscribers. Listener errors never break the emitter. */
export function emit(type, payload) {
  const set = listeners.get(type);
  if (set) {
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[bus] listener for "${type}" failed`, err);
      }
    }
  }
  const all = listeners.get('*');
  if (all) {
    for (const handler of [...all]) {
      try {
        handler({ type, payload });
      } catch (err) {
        console.error('[bus] wildcard listener failed', err);
      }
    }
  }
}

/** Remove every listener (used by teardown / tests). */
export function clearBus() {
  listeners.clear();
}
