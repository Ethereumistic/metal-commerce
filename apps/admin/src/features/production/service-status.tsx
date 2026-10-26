import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { create } from "zustand";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { getHealth } from "./api";
import type { Health, ServiceResult } from "./contracts";
import { backoff, onServiceSuccess, usePolling } from "./hooks";
import { STATUS_STALL_MS, describeHealth, formatDuration, healthFreshness, type HealthView } from "./results-logic";
import { OfflineAlert } from "./status";

const HEALTHY_INTERVAL_MS = 30_000;
const NOT_READY_INTERVAL_MS = 10_000;
const MAX_RETRY_MS = 60_000;
/** A successful operation re-checks a bad health reading at most this often. */
const RECHECK_AFTER_SUCCESS_MS = 2_000;
/**
 * The admin server bounds each of its own calls (a sign-in refresh, the
 * membership check, the service) to 15 s; a check still unanswered after
 * this means the admin server itself stalled, so the browser stops waiting.
 * The indicator already reports a stall after STATUS_STALL_MS.
 */
const CHECK_TIMEOUT_MS = 50_000;

type HealthState = {
  result: ServiceResult<Health> | null;
  /** When the last answer arrived (null before the first). */
  checkedAt: number | null;
  /** When the check in flight started (null when none is running). */
  checkingSince: number | null;
  /** The last check got no answer in time; cleared by the next answer. */
  timedOut: boolean;
  /** When the worker was first seen not ready in the current stretch (null while ready). */
  notReadySince: number | null;
  /** When a re-check was last requested after a successful operation. */
  recheckedAt: number;
  /** Bumped to make the monitor check again right away. */
  nonce: number;
};

// Health lives in its own small store so a check re-renders only the status
// indicator and the alert, never the stage the operator is typing in.
const useHealthStore = create<HealthState>(() => ({
  result: null,
  checkedAt: null,
  checkingSince: null,
  timedOut: false,
  notReadySince: null,
  recheckedAt: 0,
  nonce: 0,
}));

function record(result: ServiceResult<Health>) {
  const now = Date.now();
  useHealthStore.setState((state) => ({
    result,
    checkedAt: now,
    timedOut: false,
    notReadySince: result.ok && !result.data.worker_ready ? (state.notReadySince ?? now) : null,
  }));
}

/** One health request; null when it got no answer in time or was abandoned. Not via attempt(), so it does not count as an operation. */
async function request(signal: AbortSignal): Promise<ServiceResult<Health> | null> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
  try {
    return await getHealth({ signal: bounded });
  } catch {
    if (bounded.aborted) return null;
    return {
      ok: false,
      offline: false,
      error: {
        code: "REQUEST_FAILED",
        message: "The admin server could not be reached. Check this computer's network connection.",
      },
    };
  }
}

let inflight: { promise: Promise<ServiceResult<Health> | null>; controller: AbortController } | null = null;

/** Single-flight: a check while one is running waits for that one instead of starting another. */
function check(): Promise<ServiceResult<Health> | null> {
  if (inflight) return inflight.promise;
  const controller = new AbortController();
  useHealthStore.setState({ checkingSince: Date.now() });
  const promise = request(controller.signal).then((result) => {
    // A check the operator abandoned settles nothing; its replacement does.
    if (inflight?.controller !== controller) return result;
    inflight = null;
    if (result) record(result);
    useHealthStore.setState({ checkingSince: null, ...(result ? {} : { timedOut: true }) });
    return result;
  });
  inflight = { promise, controller };
  return promise;
}

/** Checks again now; a check that has stalled is abandoned, one that is merely running is joined. */
function recheck() {
  const { checkingSince } = useHealthStore.getState();
  if (inflight && checkingSince != null && Date.now() - checkingSince >= STATUS_STALL_MS) {
    inflight.controller.abort();
    inflight = null;
    useHealthStore.setState({ checkingSince: null });
  }
  useHealthStore.setState((state) => ({ nonce: state.nonce + 1 }));
}

/**
 * Service health, re-checked periodically and more slowly while it is down.
 * Any successful operation (a job accepted, a batch loaded) re-checks a bad
 * reading at once, so the banner never contradicts what just worked.
 * Renders nothing.
 */
export function HealthMonitor() {
  const retry = useRef(5_000);
  const nonce = useHealthStore((state) => state.nonce);
  useEffect(
    () =>
      onServiceSuccess(() => {
        const { result, recheckedAt } = useHealthStore.getState();
        const healthy = result?.ok && result.data.worker_ready;
        if (!healthy && Date.now() - recheckedAt > RECHECK_AFTER_SUCCESS_MS) {
          useHealthStore.setState({ recheckedAt: Date.now() });
          recheck();
        }
      }),
    [],
  );
  usePolling(async () => {
    const next = await check();
    if (next?.ok) {
      retry.current = 5_000;
      return next.data.worker_ready ? HEALTHY_INTERVAL_MS : NOT_READY_INTERVAL_MS;
    }
    // A disabled or misconfigured admin will not fix itself; stop asking.
    if (next && !next.offline && ["PRODUCTION_DISABLED", "PRODUCTION_MISCONFIGURED"].includes(next.error.code))
      return null;
    const delay = retry.current;
    retry.current = backoff(delay, MAX_RETRY_MS);
    return delay;
  }, [nonce]);
  return null;
}

/** The current time, refreshed every few seconds so "starting" can become "not responding" and "checked … ago" ages. */
function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(now, Date.now());
}

/** The health reading in words. */
function useHealthView(now: number): HealthView {
  const result = useHealthStore((state) => state.result);
  const notReadySince = useHealthStore((state) => state.notReadySince);
  return describeHealth(result, notReadySince, now);
}

/** The service problem banner, shown under the workspace header. */
export function HealthAlert() {
  const result = useHealthStore((state) => state.result);
  const view = useHealthView(useClock());
  if (!result) return null;
  if (!result.ok)
    return (
      <div className="border-b p-3">
        {result.offline ? (
          <OfflineAlert />
        ) : (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Production processing unavailable</AlertTitle>
            <AlertDescription>{result.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  if (view.tone !== "warn") return null;
  return (
    <div className="border-b border-l-4 border-l-ws-hazard bg-ws-hazard/10 px-3 py-2 text-sm" role="status">
      <span className="font-medium">{view.label}.</span> {view.detail}
    </div>
  );
}

const DOT: Record<HealthView["tone"], string> = {
  good: "bg-ws-cut",
  busy: "bg-ws-temper animate-pulse",
  warn: "bg-ws-hazard",
  down: "bg-ws-spark",
  unknown: "bg-muted-foreground",
};

export function ServiceStatus({ className }: { className?: string }) {
  const now = useClock();
  const view = useHealthView(now);
  const result = useHealthStore((state) => state.result);
  const checkedAt = useHealthStore((state) => state.checkedAt);
  const checkingSince = useHealthStore((state) => state.checkingSince);
  const timedOut = useHealthStore((state) => state.timedOut);
  const freshness = healthFreshness(checkedAt, checkingSince, timedOut, now);
  const canRetry = freshness.stalled || (result != null && !result.ok);
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="status"
              tabIndex={0}
              className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-xs text-muted-foreground"
            />
          }
        >
          <span className={cn("size-2 shrink-0 rounded-full", freshness.stalled ? "bg-ws-hazard" : DOT[view.tone])} />
          <span className="truncate">
            {freshness.stalled ? (checkedAt == null ? "Status check not answering" : `${view.label}, checked ${formatDuration((now - checkedAt) / 1000)} ago`) : view.label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">
          {view.detail ? `${view.detail} ` : ""}
          {freshness.text}
        </TooltipContent>
      </Tooltip>
      {canRetry && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Check the service again"
          title="Check the service again"
          disabled={checkingSince != null && !freshness.stalled}
          onClick={recheck}
        >
          <RefreshCw className={checkingSince != null ? "animate-spin" : undefined} />
        </Button>
      )}
    </div>
  );
}
