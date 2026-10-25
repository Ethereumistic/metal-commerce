import { useEffect, useMemo, useRef } from "react";
import { newIdempotencyKey } from "./api";
import type { ServiceError, ServiceResult } from "./contracts";

// Browser-side helpers shared by the Production workspace: a uniform result
// for server-function calls, idempotency keys that survive retries and
// reloads, and polling with backoff.

const REQUEST_FAILED: ServiceError = {
  code: "REQUEST_FAILED",
  message:
    "The admin server could not be reached or refused the request. Check your connection and try again.",
};

/** Runs a server function; a thrown error (network, validation) becomes a failed result. */
export async function attempt<T>(
  work: () => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  try {
    return await work();
  } catch {
    return { ok: false, offline: false, error: REQUEST_FAILED };
  }
}

// Failures after which the service may or may not have accepted the request.
const UNCERTAIN = new Set(["REQUEST_FAILED", "INVALID_RESPONSE", "SERVICE_ERROR"]);

/** True when a mutation's outcome is unknown, so a retry must reuse its key. */
export function isUncertain(result: ServiceResult<unknown>) {
  return !result.ok && (result.offline || UNCERTAIN.has(result.error.code));
}

const KEY_PREFIX = "metal-admin-production-key:";

function readKey(scope: string): { fingerprint: string; key: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY_PREFIX + scope) ?? "null") as {
      fingerprint?: unknown;
      key?: unknown;
    } | null;
    return value && typeof value.fingerprint === "string" && typeof value.key === "string"
      ? { fingerprint: value.fingerprint, key: value.key }
      : null;
  } catch {
    return null;
  }
}

function writeKey(scope: string, value: { fingerprint: string; key: string } | null) {
  try {
    if (value) localStorage.setItem(KEY_PREFIX + scope, JSON.stringify(value));
    else localStorage.removeItem(KEY_PREFIX + scope);
  } catch {
    // Without storage the key still lives for this page.
  }
}

/**
 * Idempotency keys for one kind of operator action. The same payload keeps
 * its key until the service gives a definite answer, including across a
 * reload, so retrying an uncertain submission never queues work twice.
 */
export function useActionKey(scope: string) {
  const memory = useRef<{ fingerprint: string; key: string } | null>(null);
  return useMemo(
    () => ({
      key(fingerprint: string) {
        const current = memory.current ?? readKey(scope);
        if (current?.fingerprint === fingerprint) return current.key;
        const next = { fingerprint, key: newIdempotencyKey() };
        memory.current = next;
        writeKey(scope, next);
        return next.key;
      },
      settle(result: ServiceResult<unknown>) {
        if (isUncertain(result)) return;
        memory.current = null;
        writeKey(scope, null);
      },
    }),
    [scope],
  );
}

/**
 * Calls `poll` until it returns a delay of null. The delay is chosen by the
 * caller from each result (backoff), and polling stops when the inputs change
 * or the component unmounts.
 */
export function usePolling(
  poll: (() => Promise<number | null>) | null,
  deps: readonly unknown[],
) {
  useEffect(() => {
    if (!poll) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const delay = await poll();
      if (stopped || delay == null) return;
      // A hidden tab checks in rarely; the job keeps running on the service.
      timer = setTimeout(tick, document.hidden ? Math.max(delay, 15_000) : delay);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // The caller lists what `poll` depends on.
  }, deps);
}

/** Doubles a delay up to a ceiling. */
export function backoff(delay: number, max: number) {
  return Math.min(Math.round(delay * 2), max);
}
