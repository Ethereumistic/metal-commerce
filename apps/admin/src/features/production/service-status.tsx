import { useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { getHealth } from "./api";
import type { Health, ServiceResult } from "./contracts";
import { attempt, backoff, usePolling } from "./hooks";
import { OFFLINE_TITLE } from "./status";

const HEALTHY_INTERVAL_MS = 30_000;
const MAX_RETRY_MS = 60_000;

/** Service health, re-checked periodically and more slowly while it is down. */
export function useHealth() {
  const [result, setResult] = useState<ServiceResult<Health> | null>(null);
  const retry = useRef(5_000);
  usePolling(async () => {
    const next = await attempt(() => getHealth());
    setResult(next);
    if (next.ok) {
      retry.current = 5_000;
      return HEALTHY_INTERVAL_MS;
    }
    // A disabled or misconfigured admin will not fix itself; stop asking.
    if (!next.offline && ["PRODUCTION_DISABLED", "PRODUCTION_MISCONFIGURED"].includes(next.error.code))
      return null;
    const delay = retry.current;
    retry.current = backoff(delay, MAX_RETRY_MS);
    return delay;
  }, []);
  return result;
}

export function ServiceStatus({ health }: { health: ServiceResult<Health> | null }) {
  const state = !health
    ? { dot: "bg-muted-foreground", label: "Checking service…", detail: null }
    : health.ok
      ? {
          dot: health.data.worker_ready ? "bg-emerald-500" : "bg-amber-500",
          label: health.data.worker_ready ? "Service online" : "Service online · worker starting",
          detail: `v${health.data.service_version} · queue ${health.data.queue.queued} queued, ${health.data.queue.running} running · tracer ${health.data.tracer_version} · solver ${health.data.solver_version} · exporter ${health.data.exporter_version}`,
        }
      : health.offline
        ? { dot: "bg-destructive", label: OFFLINE_TITLE, detail: "Retrying automatically." }
        : { dot: "bg-destructive", label: health.error.code, detail: health.error.message };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground"
          />
        }
      >
        <span className={cn("size-2 shrink-0 rounded-full", state.dot)} />
        <span className="truncate">{state.label}</span>
      </TooltipTrigger>
      {state.detail && <TooltipContent>{state.detail}</TooltipContent>}
    </Tooltip>
  );
}
