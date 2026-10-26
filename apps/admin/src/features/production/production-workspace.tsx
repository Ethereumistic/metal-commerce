import { useEffect, useRef, type ReactNode } from "react";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { FilePlus2 } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Separator } from "@workspace/ui/components/separator";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";
import { BatchEditor, BatchFooter } from "./batch-editor";
import { requestFocus } from "./focus";
import { isTerminal, JobProgress, useJob } from "./job-progress";
import { PreparationFollower, ProductPicker } from "./product-picker";
import type { Stage, StudioSearch } from "./search";
import { HealthAlert, HealthMonitor, ServiceStatus } from "./service-status";
import { BatchResult } from "./sheet-preview";
import { SheetSettings } from "./sheet-settings";
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
  onStartNew,
}: {
  jobId: string | null;
  batch: string | null;
  canEdit: boolean;
  onStartNew: () => void;
}) {
  const jobState = useJob(jobId);
  const job = jobState.job;
  const batchId = batch ?? job?.result?.batch_id ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      {jobId && <JobProgress jobId={jobId} state={jobState} canEdit={canEdit} />}
      {batchId ? (
        <BatchResult batchId={batchId} refreshKey={job?.status ?? null} />
      ) : (
        !jobId && (
          <p className="text-sm text-muted-foreground">
            No nesting run yet. Run nesting on the Sheets step.
          </p>
        )
      )}
      {(isTerminal(job) || (!jobId && batchId)) && (
        <Button variant="outline" size="sm" className="self-start" onClick={onStartNew}>
          <FilePlus2 /> Start another batch
        </Button>
      )}
    </div>
  );
}

export function ProductionWorkspace({ switcher }: { switcher: ReactNode }) {
  const { session } = useRouteContext({ from: "/_app" });
  const canEdit = session.business.canEdit;
  const [search, setSearch] = useProductionSearch();
  const stage: Stage = search.stage ?? (search.job || search.batch ? "results" : "products");
  const selectedCount = useProduction((state) => Object.keys(state.selected).length);
  const lineCount = useProduction((state) => state.lines.length);
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

  const startNew = () => {
    writeActiveRun(null);
    setSearch({ job: undefined, batch: undefined, stage: "batch" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HealthMonitor />
      <PreparationFollower />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
        {switcher}
        <Separator orientation="vertical" className="mx-1 data-vertical:h-5 data-vertical:self-auto" />
        <Tabs value={stage} onValueChange={(value) => setSearch({ stage: value as Stage })}>
          <TabsList>
            <TabsTrigger value="products">1 · Products{selectedCount ? ` (${selectedCount})` : ""}</TabsTrigger>
            <TabsTrigger value="batch">2 · Batch{lineCount ? ` (${lineCount})` : ""}</TabsTrigger>
            <TabsTrigger value="sheets">3 · Sheets</TabsTrigger>
            <TabsTrigger value="results">4 · Results</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="flex-1" />
        <ServiceStatus />
      </div>

      <HealthAlert />

      {pickerOpened.current && (
        <div className={cn("flex min-h-0 flex-1 flex-col", stage !== "products" && "hidden")}>
          <ProductPicker canEdit={canEdit} onContinue={() => setSearch({ stage: "batch" })} />
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
          onStartNew={startNew}
        />
      )}
    </div>
  );
}
