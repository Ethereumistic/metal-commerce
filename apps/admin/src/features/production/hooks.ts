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

const successListeners = new Set<() => void>();

/** Called after any server function answers successfully (e.g. to re-check a stale health banner). */
export function onServiceSuccess(listener: () => void) {
  successListeners.add(listener);
  return () => void successListeners.delete(listener);
}

/**
 * Whether a thrown error means the request never got an answer. fetch
 * reports network failures as TypeError; anything else was thrown by the
 * admin server (input validation) and carries a message worth showing.
 */
function isNetworkFailure(error: unknown) {
  return error instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false);
}

/** Runs a server function; a thrown error (network, validation) becomes a failed result. */
export async function attempt<T>(
  work: () => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  try {
    const result = await work();
    if (result.ok) for (const listener of successListeners) listener();
    return result;
  } catch (error) {
    if (isNetworkFailure(error)) return { ok: false, offline: false, error: REQUEST_FAILED };
    const message = error instanceof Error ? error.message.trim().slice(0, 300) : "";
    return {
      ok: false,
      offline: false,
      error: {
        code: "REQUEST_REJECTED",
        message: message
          ? `The admin server rejected the request: ${message}`
          : "The admin server rejected the request without a reason. Reload the page and try again.",
      },
    };
  }
}

// Failures after which the service may or may not have accepted the request.
// A rejection is listed too: reusing its key for the same payload is always safe.
const UNCERTAIN = new Set(["REQUEST_FAILED", "REQUEST_REJECTED", "INVALID_RESPONSE", "SERVICE_ERROR"]);

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
