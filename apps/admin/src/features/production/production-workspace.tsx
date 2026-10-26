import { useEffect, useRef, type ReactNode } from "react";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Separator } from "@workspace/ui/components/separator";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";
import { BatchEditor, BatchFooter } from "./batch-editor";
import { requestFocus } from "./focus";
import { JobProgress, useJob } from "./job-progress";
import { PreparationFollower, ProductPicker } from "./product-picker";
import type { Stage, StudioSearch } from "./search";
import { HealthAlert, HealthMonitor, ServiceStatus } from "./service-status";
import { BatchResult } from "./sheet-preview";
import { SheetSettings } from "./sheet-settings";
import { batchLimitProblems } from "./batch-logic";
import { lineIssues } from "./validation";
import { flushProductionState, readActiveRun, useProduction, writeActiveRun } from "./store";

function useProductionSearch() {
  const search = useSearch({ from: "/_app/studio" });
  const navigate = useNavigate({ from: "/studio" });
  const update = (patch: Partial<StudioSearch>, replace = false) => {
    // Moving between steps is a natural point to save what was entered.
    if (patch.stage) flushProductionState();
    void navigate({
      search: (previous: StudioSearch) => ({ ...previous, ...patch, workspace: "production" as const }),
      replace,
    });
  };
  return [search, update] as const;
}

/**
 * The Results step. Job polling lives here so its updates re-render only
 * this step, not the input steps.
 */
function ResultsStage({
  jobId,
  batch,
  canEdit,
  onOpenDraft,
}: {
  jobId: string | null;
  batch: string | null;
  canEdit: boolean;
  onOpenDraft: () => void;
}) {
  const jobState = useJob(jobId);
  const job = jobState.job;
  const batchId = batch ?? job?.result?.batch_id ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:overflow-hidden">
      {jobId && <JobProgress jobId={jobId} state={jobState} canEdit={canEdit} />}
      {batchId ? (
        <BatchResult batchId={batchId} refreshKey={job?.status ?? null} onOpenDraft={onOpenDraft} />
      ) : (
        !jobId && (
          <div className="flex flex-1 flex-col items-start gap-2 p-6 text-sm text-muted-foreground">
            <p>No nesting run is open. Run nesting from the Sheets step, or open a batch from Production history.</p>
            <Button variant="outline" size="sm" onClick={onOpenDraft}>
              Go to the current draft
            </Button>
          </div>
        )
      )}
    </div>
  );
}

function StageLabel({ number, label, count, attention }: { number: number; label: string; count?: number; attention?: boolean }) {
  return (
    <>
      <span className="ws-numeral text-base text-muted-foreground group-data-active/tab:text-ws-temper">{number}</span>
      <span>{label}</span>
      {count ? <span className="text-xs text-muted-foreground tabular-nums">{count}</span> : null}
      {attention && <span className="size-1.5 rounded-full bg-ws-hazard" aria-label="needs attention" />}
    </>
  );
}

export function ProductionWorkspace({ switcher }: { switcher: ReactNode }) {
  const { session } = useRouteContext({ from: "/_app" });
  const canEdit = session.business.canEdit;
  const [search, setSearch] = useProductionSearch();
  const stage: Stage = search.stage ?? (search.job || search.batch ? "results" : "products");
  const selectedCount = useProduction((state) => Object.keys(state.selected).length);
  const lineCount = useProduction((state) => state.lines.length);
  // Only rows whose master is loaded are judged, so the dot never flashes while masters load.
  const needsAttention = useProduction((state) =>
    state.lines.some((line) => {
      const master = state.masters[line.masterId];
      return !!master && lineIssues(line, master.aspect_ratio).length > 0;
    }) || batchLimitProblems(state.lines).length > 0,
  );
  // The picker stays mounted (hidden) once opened, so its search, loaded
  // pages and scroll position survive a trip to another step.
  const pickerOpened = useRef(false);
  if (stage === "products") pickerOpened.current = true;

  // Resume the last accepted run after a reload (the URL wins when it names one).
  useEffect(() => {
    if (search.job || search.batch) return;
    const run = readActiveRun();
    if (run) setSearch({ job: run.jobId, batch: run.batchId ?? undefined }, true);
    // Only on entering the workspace.
  }, []);

  // Keep localStorage pointing at the run in the URL (e.g. opened from history).
  useEffect(() => {
    if (search.job) writeActiveRun({ jobId: search.job, batchId: search.batch ?? null });
  }, [search.job, search.batch]);

  // Leaves the run on screen for the draft the browser holds (resume, not repeat).
  const openDraft = () => {
    writeActiveRun(null);
    setSearch({ job: undefined, batch: undefined, stage: lineCount ? "batch" : "products" });
  };

  return (
    <div className="workshop flex min-h-0 flex-1 flex-col">
      <HealthMonitor />
      <PreparationFollower />
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 border-b px-2 py-1">
        {switcher}
        <Separator orientation="vertical" className="mx-1 data-vertical:h-5 data-vertical:self-auto" />
        <Tabs value={stage} onValueChange={(value) => setSearch({ stage: value as Stage })}>
          <TabsList variant="line" aria-label="Production steps" className="gap-1">
            <TabsTrigger value="products" className="group/tab gap-1.5 px-2">
              <StageLabel number={1} label="Products" count={selectedCount} />
            </TabsTrigger>
            <TabsTrigger value="batch" className="group/tab gap-1.5 px-2">
              <StageLabel number={2} label="Batch" count={lineCount} attention={needsAttention} />
            </TabsTrigger>
            <TabsTrigger value="sheets" className="group/tab gap-1.5 px-2">
              <StageLabel number={3} label="Sheets" />
            </TabsTrigger>
            <TabsTrigger value="results" className="group/tab gap-1.5 px-2">
              <StageLabel number={4} label="Results" />
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="flex-1" />
        <ServiceStatus className="max-w-56" />
      </div>

      <HealthAlert />

      {pickerOpened.current && (
        <div className={cn("flex min-h-0 flex-1 flex-col", stage !== "products" && "hidden")}>
          <ProductPicker
            canEdit={canEdit}
            initialQuery={search.q ?? ""}
            onContinue={() => setSearch({ stage: "batch", q: undefined })}
          />
        </div>
      )}
      {stage === "batch" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <BatchEditor />
          <BatchFooter onContinue={() => setSearch({ stage: "sheets" })} />
        </div>
      )}
      {stage === "sheets" && (
        <SheetSettings
          canEdit={canEdit}
          onEditLine={(lineId, field) => {
            requestFocus({ scope: "line", lineId, field });
            setSearch({ stage: "batch" });
          }}
          onStarted={({ jobId, batchId: started }) => {
            writeActiveRun({ jobId, batchId: started });
            setSearch({ job: jobId, batch: started, stage: "results" });
          }}
        />
      )}
      {stage === "results" && (
        <ResultsStage
          jobId={search.job ?? null}
          batch={search.batch ?? null}
          canEdit={canEdit}
          onOpenDraft={openDraft}
        />
      )}
    </div>
  );
}
