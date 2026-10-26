import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { create } from "zustand";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { getHealth } from "./api";
import type { Health, ServiceResult } from "./contracts";
import { backoff, onServiceSuccess, usePolling } from "./hooks";
import { describeHealth, type HealthView } from "./results-logic";
import { OfflineAlert } from "./status";

const HEALTHY_INTERVAL_MS = 30_000;
const NOT_READY_INTERVAL_MS = 10_000;
const MAX_RETRY_MS = 60_000;
/** A successful operation re-checks a bad health reading at most this often. */
const RECHECK_AFTER_SUCCESS_MS = 2_000;

type HealthState = {
  result: ServiceResult<Health> | null;
  checkedAt: number;
  /** When the worker was first seen not ready in the current stretch (null while ready). */
  notReadySince: number | null;
  /** Bumped to make the monitor check again right away. */
  nonce: number;
};

// Health lives in its own small store so a check re-renders only the status
// indicator and the alert, never the stage the operator is typing in.
const useHealthStore = create<HealthState>(() => ({ result: null, checkedAt: 0, notReadySince: null, nonce: 0 }));

function record(result: ServiceResult<Health>) {
  const now = Date.now();
  useHealthStore.setState((state) => ({
    result,
    checkedAt: now,
    notReadySince: result.ok && !result.data.worker_ready ? (state.notReadySince ?? now) : null,
  }));
}

/** Health without going through attempt(), so its own success does not count as an operation. */
async function check(): Promise<ServiceResult<Health>> {
  try {
    return await getHealth();
  } catch {
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
        const { result, checkedAt } = useHealthStore.getState();
        const healthy = result?.ok && result.data.worker_ready;
        if (!healthy && Date.now() - checkedAt > RECHECK_AFTER_SUCCESS_MS)
          useHealthStore.setState((state) => ({ nonce: state.nonce + 1, checkedAt: Date.now() }));
      }),
    [],
  );
  usePolling(async () => {
    const next = await check();
    record(next);
    if (next.ok) {
      retry.current = 5_000;
      return next.data.worker_ready ? HEALTHY_INTERVAL_MS : NOT_READY_INTERVAL_MS;
    }
    // A disabled or misconfigured admin will not fix itself; stop asking.
    if (!next.offline && ["PRODUCTION_DISABLED", "PRODUCTION_MISCONFIGURED"].includes(next.error.code))
      return null;
    const delay = retry.current;
    retry.current = backoff(delay, MAX_RETRY_MS);
    return delay;
  }, [nonce]);
  return null;
}

/** The health reading in words, refreshed every few seconds so "starting" can become "not responding". */
function useHealthView(): HealthView {
  const result = useHealthStore((state) => state.result);
  const notReadySince = useHealthStore((state) => state.notReadySince);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (notReadySince == null) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [notReadySince]);
  return describeHealth(result, notReadySince, Math.max(now, Date.now()));
}

/** The service problem banner, shown under the workspace header. */
export function HealthAlert() {
  const result = useHealthStore((state) => state.result);
  const view = useHealthView();
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
  const view = useHealthView();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            tabIndex={0}
            className={cn("flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-xs text-muted-foreground", className)}
          />
        }
      >
        <span className={cn("size-2 shrink-0 rounded-full", DOT[view.tone])} />
        <span className="truncate">{view.label}</span>
      </TooltipTrigger>
      {view.detail && <TooltipContent className="max-w-80">{view.detail}</TooltipContent>}
    </Tooltip>
  );
}
