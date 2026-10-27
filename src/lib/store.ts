// The small observable stores the data modules keep (the shelf, settings,
// annotations, stats...): screens read a value with useValue() and are drawn
// again when the module calls notify().

import { useSyncExternalStore } from 'react';

export interface Store {
  subscribe(listener: () => void): () => void;
  /** Tell every screen reading from this store to read again. */
  notify(): void;
  /** Read `get()` in a component, drawn again on every notify(). */
  useValue<T>(get: () => T): T;
}

export function createStore(): Store {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function useValue<T>(get: () => T): T {
    return useSyncExternalStore(subscribe, get);
  }
  return {
    subscribe,
    notify: () => listeners.forEach((l) => l()),
    useValue,
  };
}
