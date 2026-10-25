import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";
import { PageHeader } from "@/components/placeholder-page";
import { listBatches, listJobs } from "./api";
import type { BatchSummary, Job, ServiceResult } from "./contracts";
import { attempt } from "./hooks";
import { ServiceStatus, useHealth } from "./service-status";
import { BatchBadge, JobBadge, ResultAlert, formatDate } from "./status";

const LIMIT = 25;

function useHistory() {
  const [batches, setBatches] = useState<ServiceResult<BatchSummary[]> | null>(null);
  const [jobs, setJobs] = useState<ServiceResult<Job[]> | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([
      attempt(() => listBatches({ data: { limit: LIMIT } })),
      attempt(() => listJobs({ data: { limit: LIMIT } })),
    ]).then(([nextBatches, nextJobs]) => {
      if (!active) return;
      setBatches(nextBatches);
      setJobs(nextJobs);
    });
    return () => {
      active = false;
    };
  }, [nonce]);
  return { batches, jobs, reload: () => setNonce((value) => value + 1) };
}

const linkClass = buttonVariants({ variant: "ghost", size: "sm" });

/** Job and batch history kept on the artwork service, linking into Studio › Production. */
export function ProductionHistory() {
  const health = useHealth();
  const { batches, jobs, reload } = useHistory();
  const offline = (batches && !batches.ok && batches.offline) || (jobs && !jobs.ok && jobs.offline);
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Production"
          description="Tracing and nesting runs on the workshop PC. Open a batch to see its sheets and downloads."
        />
        <div className="flex items-center gap-2">
          <ServiceStatus health={health} />
          <Link to="/studio" search={{ workspace: "production" }} className={buttonVariants({ size: "sm" })}>
            Open Production workspace
          </Link>
        </div>
      </div>

      {offline ? (
        <ResultAlert result={{ ok: false, offline: true }} title="" />
      ) : (
        <>
          {batches && <ResultAlert result={batches} title="Batch history unavailable" />}
          {jobs && <ResultAlert result={jobs} title="Job history unavailable" />}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Batches</CardTitle>
          <CardDescription>The {LIMIT} most recent batches.</CardDescription>
          <CardAction>
            <Button variant="ghost" size="icon-sm" aria-label="Reload history" onClick={reload}>
              <RefreshCw />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {batches?.ok && batches.data.length === 0 && (
            <p className="text-sm text-muted-foreground">No batches yet.</p>
          )}
          {batches?.ok && batches.data.length > 0 && (
            <ul className="divide-y">
              {batches.data.map((batch) => (
                <li key={batch.batch_id} className="flex items-center gap-3 py-2 text-sm">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{batch.name ?? batch.batch_id}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(batch.created_at)}
                      {batch.totals &&
                        ` · ${batch.totals.placed}/${batch.totals.requested} placed on ${batch.totals.sheet_count} sheets`}
                    </span>
                  </div>
                  <BatchBadge status={batch.status} />
                  <Link
                    to="/studio"
                    search={{ workspace: "production", stage: "results", batch: batch.batch_id }}
                    className={linkClass}
                  >
                    Open <ArrowRight />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>Recent tracing and nesting jobs. Accepted jobs keep running if the browser closes.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs?.ok && jobs.data.length === 0 && <p className="text-sm text-muted-foreground">No jobs yet.</p>}
          {jobs?.ok && jobs.data.length > 0 && (
            <ul className="divide-y">
              {jobs.data.map((job) => (
                <li key={job.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-12 text-xs text-muted-foreground uppercase">{job.kind}</span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs">{job.id}</span>
                    <span className="text-xs text-muted-foreground">
                      {job.stage ?? "—"} · {Math.round(job.progress * 100)}% · updated {formatDate(job.updated_at)}
                    </span>
                    {job.error && (
                      <span className="text-xs text-destructive">
                        {job.error.code} · {job.error.message}
                      </span>
                    )}
                  </div>
                  <JobBadge status={job.status} />
                  {job.kind === "nest" && (
                    <Link
                      to="/studio"
                      search={{
                        workspace: "production",
                        stage: "results",
                        job: job.id,
                        ...(job.result?.batch_id ? { batch: job.result.batch_id } : {}),
                      }}
                      className={linkClass}
                    >
                      Open <ArrowRight />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
