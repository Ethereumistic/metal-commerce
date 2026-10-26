import type { PersistStorage, StorageValue } from "zustand/middleware";

// Zustand's JSON storage stringifies and writes the whole store on every
// change, which put a synchronous localStorage write on each keystroke. This
// storage keeps the latest value in memory and writes it once the operator
// pauses, and immediately when the page is hidden or the operator moves to
// another step, so nothing typed is lost.

export type DebouncedStorage<S> = PersistStorage<S, void> & {
  /** Writes any pending value now. */
  flush: () => void;
};

type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createDebouncedStorage<S>(
  getStorage: () => Storage,
  delayMs = 300,
  timers: Timers = defaultTimers,
): DebouncedStorage<S> {
  const pending = new Map<string, StorageValue<S>>();
  let timer: unknown = null;

  const storage = (): Storage | null => {
    try {
      return getStorage();
    } catch {
      // No storage on the server or in a locked-down browser; state lives for this page only.
      return null;
    }
  };

  const flush = () => {
    if (timer != null) timers.clear(timer);
    timer = null;
    if (!pending.size) return;
    const target = storage();
    const entries = [...pending];
    pending.clear();
    if (!target) return;
    for (const [name, value] of entries) {
      try {
        target.setItem(name, JSON.stringify(value));
      } catch (error) {
        // Quota or privacy errors: the page keeps working, the next reload starts fresh.
        console.warn(`Could not save ${name} to browser storage.`, error);
      }
    }
  };

  return {
    getItem(name) {
      const waiting = pending.get(name);
      if (waiting) return waiting;
      const raw = storage()?.getItem(name);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      pending.set(name, value);
      if (timer != null) timers.clear(timer);
      timer = timers.set(flush, delayMs);
    },
    removeItem(name) {
      pending.delete(name);
      storage()?.removeItem(name);
    },
    flush,
  };
}

/** Flushes when the tab is hidden or the page is being unloaded (pagehide also covers bfcache). */
export function flushWhenHidden(flush: () => void) {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
