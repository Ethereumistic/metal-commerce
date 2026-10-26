import { useEffect, useRef, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { cancelJob, getJob } from "./api";
import type { Job, ServiceResult } from "./contracts";
import { attempt, backoff, useActionKey, usePolling } from "./hooks";
import { NEST_PHASES, formatDuration, nestPhase } from "./results-logic";
import { ErrorText, OfflineAlert, ResultAlert } from "./status";

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

/** Wall-clock time since the job was accepted; ticks on its own so nothing else re-renders. */
function Elapsed({ job }: { job: Job }) {
  const finished = TERMINAL.has(job.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [finished]);
  const start = Date.parse(job.created_at);
  const end = finished ? Date.parse(job.updated_at) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return <span className="tabular-nums">{formatDuration((end - start) / 1000)}</span>;
}

const PHASE_LABELS: Record<(typeof NEST_PHASES)[number], string> = {
  queued: "Queued",
  preparing: "Preparing",
  solving: "Solving",
  checking: "Checking",
  exporting: "Exporting",
};

/** `null` while the job is unknown or after it stopped early: no phase is marked. */
function Phases({ current }: { current: ReturnType<typeof nestPhase>["key"] | null }) {
  const reached = current == null ? -1 : current === "finished" ? NEST_PHASES.length : NEST_PHASES.indexOf(current);
  return (
    <ol className="grid grid-cols-5 gap-1 text-[11px]" aria-label="Nesting phases">
      {NEST_PHASES.map((phase, index) => (
        <li
          key={phase}
          aria-current={index === reached ? "step" : undefined}
          className={cn(
            "border-t-2 pt-1",
            index < reached && "border-ws-temper text-muted-foreground",
            index === reached && "border-ws-temper font-medium text-foreground",
            index > reached && "border-border text-muted-foreground",
          )}
        >
          {PHASE_LABELS[phase]}
        </li>
      ))}
    </ol>
  );
}

const STALE_HEARTBEAT_MS = 45_000;

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
  // Set the moment Cancel is pressed and kept until the job is terminal, so
  // the card never reads "running" with a live Cancel button after a click.
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelFailure, setCancelFailure] = useState<ServiceResult<Job> | null>(null);
  useEffect(() => setCancelRequested(false), [jobId]);

  async function cancel() {
    setCancelRequested(true);
    setCancelFailure(null);
    const result = await attempt(() =>
      cancelJob({ data: { id: jobId, idempotencyKey: cancelKey.key(jobId) } }),
    );
    cancelKey.settle(result);
    if (!result.ok) {
      setCancelRequested(false);
      setCancelFailure(result);
      return;
    }
    update(result.data);
    // Follow the job closely until the worker stops it.
    retry();
  }

  const running = !!job && !TERMINAL.has(job.status);
  const percent = job ? Math.round(job.progress * 100) : 0;
  const phase = job ? nestPhase(job.status, job.stage) : null;
  const heartbeatAge = job?.heartbeat_at ? Date.now() - Date.parse(job.heartbeat_at) : null;
  return (
    <section className="flex flex-col gap-2 border bg-ws-panel p-3" aria-label="Nesting job" title={`Job ${jobId}`}>
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {running && <Loader2 className="size-4 animate-spin text-ws-temper" aria-hidden />}
        <span className="font-medium">
          {cancelRequested && running ? "Cancelling…" : job ? (running ? phase?.label : JOB_DONE[job.status]) : "Loading job…"}
        </span>
        {job && (
          <span className="text-xs text-muted-foreground">
            {running ? "Elapsed " : "Took "}
            <Elapsed job={job} />
          </span>
        )}
        <span className="flex-1" />
        {running && (
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit || cancelRequested}
            onClick={() => void cancel()}
          >
            {cancelRequested ? <Loader2 className="animate-spin" /> : <Square />}
            {cancelRequested ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>
      {/* The phases, bar and summary line stay mounted from the first poll to the
          end, so finishing swaps text in place instead of collapsing the panel
          and moving the results below it. */}
      <Phases current={!job ? null : job.status === "succeeded" ? "finished" : running ? phase!.key : null} />
      <div
        className="h-1.5 overflow-hidden bg-muted"
        role="progressbar"
        aria-label="Nesting progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={cn(
            "h-full transition-[width] duration-500",
            !job || running || job.status === "succeeded" ? "bg-ws-temper" : "bg-muted-foreground/50",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="min-h-4 text-xs text-muted-foreground tabular-nums">
        {!job
          ? "Reading the job from the workshop PC…"
          : running
            ? <>
                {percent}% done
                {job.attempts > 1 && `, attempt ${job.attempts}`}
                {job.cache_hit && ", reusing a cached result"}
                {heartbeatAge != null && heartbeatAge > STALE_HEARTBEAT_MS &&
                  `. No progress report for ${formatDuration(heartbeatAge / 1000)}; the solver may be busy.`}
              </>
            : JOB_SUMMARY[job.status]?.(percent)}
      </p>
      {job?.error && !["NEST_INCOMPLETE", "CANCELLED"].includes(job.error.code) && <ErrorText error={job.error} />}
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
    </section>
  );
}

const JOB_DONE: Record<string, string> = {
  succeeded: "Nesting finished",
  failed: "Nesting stopped",
  cancelled: "Nesting cancelled",
};

const JOB_SUMMARY: Record<string, (percent: number) => string> = {
  succeeded: () => "All phases done. The sheets and files are below.",
  failed: (percent) => `Stopped at ${percent}% done.`,
  cancelled: (percent) => `Cancelled at ${percent}% done.`,
};
