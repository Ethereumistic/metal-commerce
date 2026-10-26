import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Loader2, RefreshCw, Repeat2, Search } from "lucide-react";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";
import { Segmented } from "../studio/components/fields";
import { PageHeader } from "@/components/placeholder-page";
import { getBatch, listBatches, listJobs } from "./api";
import type { BatchStatus, BatchSummary, Job, JsonValue, ServiceResult } from "./contracts";
import { attempt } from "./hooks";
import { ProductImage } from "./product-image";
import { useRepeatBatch } from "./repeat";
import { formatDuration, formatPercent, plural } from "./results-logic";
import { HealthMonitor, ServiceStatus } from "./service-status";
import { BatchBadge, JobBadge, ResultAlert, formatDate } from "./status";
import { useProduction } from "./store";

const PAGE_SIZE = 20;
const FETCH_STEPS = [50, 100, 200] as const;

function useHistory(limit: number) {
  const [batches, setBatches] = useState<ServiceResult<BatchSummary[]> | null>(null);
  const [jobs, setJobs] = useState<ServiceResult<Job[]> | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      attempt(() => listBatches({ data: { limit } })),
      attempt(() => listJobs({ data: { limit } })),
    ]).then(([nextBatches, nextJobs]) => {
      if (!active) return;
      setBatches(nextBatches);
      setJobs(nextJobs);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [nonce, limit]);
  return { batches, jobs, loading, reload: () => setNonce((value) => value + 1) };
}

type Filter = "all" | "completed" | "attention" | "cancelled";

const ATTENTION: ReadonlySet<BatchStatus> = new Set(["incomplete", "failed", "invalid"]);

function matches(batch: BatchSummary, filter: Filter, words: string[]) {
  if (filter === "completed" && batch.status !== "completed") return false;
  if (filter === "attention" && !ATTENTION.has(batch.status)) return false;
  if (filter === "cancelled" && batch.status !== "cancelled") return false;
  if (!words.length) return true;
  const haystack = `${batch.name ?? "untitled batch"} ${batch.batch_id} ${batch.status} ${formatDate(batch.created_at)}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const linkClass = buttonVariants({ variant: "ghost", size: "sm" });

function details(value: JsonValue | undefined) {
  if (value == null) return null;
  const text = JSON.stringify(value, null, 2);
  return text === "{}" ? null : text;
}

/** A trace job, named by the product this browser asked to prepare with it. */
function TraceSubject({ job }: { job: Job }) {
  const productId = useProduction(
    (state) => Object.values(state.preparation).find((entry) => entry.job_id === job.id)?.product_id ?? null,
  );
  const info = useProduction((state) => (productId ? state.products[productId] : undefined));
  const product = productId ? { name: info?.name ?? null, thumbnail: info?.thumbnail ?? null } : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProductImage thumbnail={product?.thumbnail ?? null} name={product?.name ?? undefined} className="size-9" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{product?.name ?? "Product not recorded in this browser"}</span>
        <span className="truncate text-xs text-muted-foreground">Tracing, {formatDate(job.updated_at)}</span>
      </div>
      {job.status === "failed" && (
        <Link
          to="/studio"
          search={{ workspace: "production", stage: "products", ...(product?.name ? { q: product.name } : {}) }}
          className={cn(linkClass, "ml-auto shrink-0")}
        >
          {product?.name ? "Find and trace again" : "Open Products"} <ArrowRight />
        </Link>
      )}
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const elapsed = (Date.parse(job.updated_at) - Date.parse(job.created_at)) / 1000;
  const diagnostics = job.error ? details(job.error.details) : null;
  return (
    <li className="flex flex-col gap-1 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          {job.kind === "trace" ? (
            <TraceSubject job={job} />
          ) : (
            <div className="flex min-w-0 flex-col">
              <span className="font-medium">Nesting</span>
              <span className="text-xs text-muted-foreground">
                {formatDate(job.updated_at)}
                {Number.isFinite(elapsed) && elapsed > 0 ? `, took ${formatDuration(elapsed)}` : ""}
              </span>
            </div>
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
      </div>
      {job.error && (
        <div className="border-l-4 border-l-ws-spark bg-ws-spark/10 px-2 py-1 text-xs">
          <span className="font-medium">{job.error.message || job.error.code}</span>
          {diagnostics && (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground">Diagnostics ({job.error.code})</summary>
              <pre className="mt-1 max-h-48 overflow-auto text-[11px] whitespace-pre-wrap">{diagnostics}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

function BatchRow({ batch, onRepeat, repeating }: { batch: BatchSummary; onRepeat: () => void; repeating: boolean }) {
  const totals = batch.totals;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
      <div className="flex min-w-0 flex-1 basis-64 flex-col">
        <span className="truncate font-medium" title={batch.batch_id}>
          {batch.name ?? "Untitled batch"}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDate(batch.created_at)}
          {totals &&
            `. ${totals.placed} of ${plural(totals.requested, "part")} on ${plural(totals.sheet_count, "sheet")}, ${formatPercent(totals.utilization)} coverage`}
        </span>
      </div>
      <BatchBadge status={batch.status} />
      <div className="flex items-center gap-1">
        <Link
          to="/studio"
          search={{ workspace: "production", stage: "results", batch: batch.batch_id }}
          className={linkClass}
        >
          Open <ArrowRight />
        </Link>
        <Button variant="ghost" size="sm" disabled={repeating} onClick={onRepeat}>
          {repeating ? <Loader2 className="animate-spin" /> : <Repeat2 />} Repeat
        </Button>
      </div>
    </li>
  );
}

/** Job and batch history kept on the artwork service, linking into Studio › Production. */
export function ProductionHistory() {
  const [fetchStep, setFetchStep] = useState(0);
  const limit = FETCH_STEPS[fetchStep]!;
  const { batches, jobs, loading, reload } = useHistory(limit);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const [jobFilter, setJobFilter] = useState<"problems" | "all">("problems");
  const { repeat, dialog, problem } = useRepeatBatch();
  const [repeating, setRepeating] = useState<string | null>(null);
  const [repeatFailure, setRepeatFailure] = useState<ServiceResult<unknown> | null>(null);

  const offline = (batches && !batches.ok && batches.offline) || (jobs && !jobs.ok && jobs.offline);
  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return batches?.ok ? batches.data.filter((batch) => matches(batch, filter, words)) : [];
  }, [batches, filter, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const loadedAll = batches?.ok ? batches.data.length < limit : true;
  const jobRows = jobs?.ok
    ? jobs.data.filter((job) => jobFilter === "all" || job.status === "failed" || job.status === "running" || job.status === "queued")
    : [];

  async function repeatBatch(batchId: string) {
    setRepeating(batchId);
    setRepeatFailure(null);
    const result = await attempt(() => getBatch({ data: { id: batchId } }));
    setRepeating(null);
    if (result.ok) repeat(result.data);
    else setRepeatFailure(result);
  }

  return (
    <div className="workshop -m-4 flex flex-1 flex-col gap-4 p-4 md:-m-6 md:p-6">
      <HealthMonitor />
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Production"
          description="Tracing and nesting runs on the workshop PC. Open a batch to see its sheets and files, or repeat it."
        />
        <div className="flex items-center gap-2">
          <ServiceStatus />
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
      <ResultAlert result={repeatFailure} title="Could not load the batch to repeat" />
      {problem && <p className="text-sm text-ws-spark">{problem}</p>}

      <div className="grid min-w-0 gap-8 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="batches-title">
          <div className="flex flex-wrap items-center gap-2 border-b pb-2">
            <h2 id="batches-title" className="mr-auto text-base font-semibold">
              Batches
            </h2>
            <div className="relative w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder="Search name, date or id"
                aria-label="Search batches"
                className="pl-8"
              />
            </div>
            <Segmented<Filter>
              className="w-auto [&>*]:flex-none! [&>*]:px-3!"
              value={filter}
              options={[
                { value: "all", label: "All" },
                { value: "completed", label: "Completed" },
                { value: "attention", label: "Needs attention" },
                { value: "cancelled", label: "Cancelled" },
              ]}
              onChange={(next) => {
                setFilter(next);
                setPage(0);
              }}
            />
            <Button variant="ghost" size="icon-sm" aria-label="Reload history" onClick={reload}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
            </Button>
          </div>

          {!batches && (
            <ul className="flex flex-col gap-3" aria-label="Loading batches">
              {Array.from({ length: 6 }, (_, index) => (
                <li key={index} className="h-10 animate-pulse bg-muted" />
              ))}
            </ul>
          )}
          {batches?.ok && (
            <>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {filtered.length === batches.data.length
                  ? `The ${plural(batches.data.length, "most recent batch", "most recent batches")}.`
                  : `${plural(filtered.length, "batch", "batches")} of the ${batches.data.length} most recent match.`}
              </p>
              {shown.length ? (
                <ul className="divide-y">
                  {shown.map((batch) => (
                    <BatchRow
                      key={batch.batch_id}
                      batch={batch}
                      repeating={repeating === batch.batch_id}
                      onRepeat={() => void repeatBatch(batch.batch_id)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-sm text-muted-foreground">
                  {batches.data.length ? "No batch matches. Clear the search or choose All." : "No batches yet."}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {pages > 1 && (
                  <>
                    <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
                      Newer
                    </Button>
                    <span className="tabular-nums">
                      Page {current + 1} of {pages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={current >= pages - 1}
                      onClick={() => setPage(current + 1)}
                    >
                      Older
                    </Button>
                  </>
                )}
                <span className="flex-1" />
                {!loadedAll && fetchStep < FETCH_STEPS.length - 1 && (
                  <Button variant="ghost" size="sm" disabled={loading} onClick={() => setFetchStep(fetchStep + 1)}>
                    Load up to {FETCH_STEPS[fetchStep + 1]} batches
                  </Button>
                )}
              </div>
            </>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="jobs-title">
          <div className="flex flex-wrap items-center gap-2 border-b pb-2">
            <h2 id="jobs-title" className="mr-auto text-base font-semibold">
              Jobs
            </h2>
            <Segmented<"problems" | "all">
              className="w-auto [&>*]:flex-none! [&>*]:px-3!"
              value={jobFilter}
              options={[
                { value: "problems", label: "Failed and running" },
                { value: "all", label: "All" },
              ]}
              onChange={setJobFilter}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Accepted jobs keep running if the browser closes. A failed trace links to its product so it can be traced
            again.
          </p>
          {!jobs && <div className="h-24 animate-pulse bg-muted" />}
          {jobs?.ok &&
            (jobRows.length ? (
              <ul className="divide-y">
                {jobRows.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            ) : (
              <p className="py-6 text-sm text-muted-foreground">
                {jobFilter === "problems" ? "No failed or running jobs." : "No jobs yet."}
              </p>
            ))}
        </section>
      </div>
    </div>
  );
}
