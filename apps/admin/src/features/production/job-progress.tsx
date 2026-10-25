import { useRef, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { cancelJob, getJob } from "./api";
import type { Job, ServiceResult } from "./contracts";
import { attempt, backoff, useActionKey, usePolling } from "./hooks";
import { ErrorText, JobBadge, OfflineAlert, ResultAlert, formatDate } from "./status";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const FIRST_DELAY_MS = 1_000;
const RUNNING_MAX_MS = 5_000;
const OFFLINE_MAX_MS = 30_000;

export const isTerminal = (job: Job | null) => !!job && TERMINAL.has(job.status);

/**
 * Follows one job on the service with backoff until it finishes. The job ID
 * comes from the URL (and localStorage), so a reload picks the same job up
 * again; this never submits anything.
 */
export function useJob(jobId: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  const [failure, setFailure] = useState<ServiceResult<Job> | null>(null);
  const delay = useRef(FIRST_DELAY_MS);
  const [refresh, setRefresh] = useState(0);
  usePolling(
    jobId
      ? async () => {
          const result = await attempt(() => getJob({ data: { id: jobId } }));
          if (result.ok) {
            setJob(result.data);
            setFailure(null);
            if (TERMINAL.has(result.data.status)) return null;
            delay.current = Math.min(delay.current * 1.5, RUNNING_MAX_MS);
            return delay.current;
          }
          setFailure(result);
          if (!result.offline && ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"].includes(result.error.code))
            return null;
          delay.current = backoff(delay.current, OFFLINE_MAX_MS);
          return delay.current;
        }
      : null,
    [jobId, refresh],
  );
  return {
    job: job && job.id === jobId ? job : null,
    failure,
    update: setJob,
    retry: () => {
      delay.current = FIRST_DELAY_MS;
      setRefresh((value) => value + 1);
    },
  };
}

export function JobProgress({
  jobId,
  state,
  canEdit,
}: {
  jobId: string;
  state: ReturnType<typeof useJob>;
  canEdit: boolean;
}) {
  const { job, failure, update, retry } = state;
  const cancelKey = useActionKey(`cancel:${jobId}`);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailure, setCancelFailure] = useState<ServiceResult<Job> | null>(null);

  async function cancel() {
    setCancelling(true);
    const result = await attempt(() =>
      cancelJob({ data: { id: jobId, idempotencyKey: cancelKey.key(jobId) } }),
    );
    cancelKey.settle(result);
    setCancelling(false);
    setCancelFailure(result.ok ? null : result);
    if (result.ok) update(result.data);
  }

  const percent = job ? Math.round(job.progress * 100) : 0;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Nesting job</span>
        <span className="font-mono text-xs text-muted-foreground">{jobId}</span>
        {job && <JobBadge status={job.status} />}
        {job && !TERMINAL.has(job.status) && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <span className="flex-1" />
        {job && !TERMINAL.has(job.status) && (
          <Button variant="outline" size="sm" disabled={!canEdit || cancelling} onClick={() => void cancel()}>
            <Square /> Cancel
          </Button>
        )}
      </div>
      {job && (
        <>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {job.stage ?? "waiting"} · {percent}% · attempt {job.attempts}
            {job.cache_hit && " · reused cached result"} · last heartbeat {formatDate(job.heartbeat_at)}
          </p>
          {job.error && <ErrorText error={job.error} />}
        </>
      )}
      {!job && !failure && <p className="text-xs text-muted-foreground">Loading job…</p>}
      {failure && !failure.ok && failure.offline && (
        <OfflineAlert>
          The job was accepted earlier and keeps running on the workshop PC. Progress resumes here
          when the service is reachable again.
        </OfflineAlert>
      )}
      {failure && !failure.ok && !failure.offline && (
        <div className="flex flex-col gap-2">
          <ResultAlert result={failure} title="Job unavailable" />
          <Button variant="outline" size="sm" className="self-start" onClick={retry}>
            Check again
          </Button>
        </div>
      )}
      <ResultAlert result={cancelFailure} title="Cancel failed" />
    </div>
  );
}
