import { useEffect, type ReactNode } from "react";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { AlertTriangle, FilePlus2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Separator } from "@workspace/ui/components/separator";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { BatchEditor } from "./batch-editor";
import { isTerminal, JobProgress, useJob } from "./job-progress";
import { ProductPicker, usePreparationJobs } from "./product-picker";
import type { Stage, StudioSearch } from "./search";
import { ServiceStatus, useHealth } from "./service-status";
import { BatchResult } from "./sheet-preview";
import { SheetSettings } from "./sheet-settings";
import { OfflineAlert } from "./status";
import { readActiveRun, useProduction, writeActiveRun } from "./store";

function useProductionSearch() {
  const search = useSearch({ from: "/_app/studio" });
  const navigate = useNavigate({ from: "/studio" });
  const update = (patch: Partial<StudioSearch>, replace = false) =>
    void navigate({
      search: (previous: StudioSearch) => ({ ...previous, ...patch, workspace: "production" as const }),
      replace,
    });
  return [search, update] as const;
}

export function ProductionWorkspace({ switcher }: { switcher: ReactNode }) {
  const { session } = useRouteContext({ from: "/_app" });
  const canEdit = session.business.canEdit;
  const [search, setSearch] = useProductionSearch();
  const stage: Stage = search.stage ?? (search.job || search.batch ? "results" : "products");
  const health = useHealth();
  const preparation = usePreparationJobs();
  const jobState = useJob(search.job ?? null);
  const selectedCount = useProduction((state) => Object.keys(state.selected).length);
  const lineCount = useProduction((state) => state.lines.length);
  const job = jobState.job;
  const batchId = search.batch ?? job?.result?.batch_id ?? null;

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
        <ServiceStatus health={health} />
      </div>

      {health && !health.ok && (
        <div className="border-b p-3">
          {health.offline ? (
            <OfflineAlert />
          ) : (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Production processing unavailable</AlertTitle>
              <AlertDescription>
                <span className="font-mono">{health.error.code}</span> · {health.error.message}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {stage === "products" && (
        <ProductPicker
          canEdit={canEdit}
          tracing={preparation.tracing}
          pollOffline={preparation.offline}
          onAddedToBatch={() => setSearch({ stage: "batch" })}
        />
      )}
      {stage === "batch" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <BatchEditor />
          {lineCount > 0 && (
            <div className="flex justify-end border-t p-2">
              <Button onClick={() => setSearch({ stage: "sheets" })}>Continue to sheets</Button>
            </div>
          )}
        </div>
      )}
      {stage === "sheets" && (
        <SheetSettings
          canEdit={canEdit}
          onStarted={({ jobId, batchId: started }) => {
            writeActiveRun({ jobId, batchId: started });
            setSearch({ job: jobId, batch: started, stage: "results" });
          }}
        />
      )}
      {stage === "results" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          {search.job && <JobProgress jobId={search.job} state={jobState} canEdit={canEdit} />}
          {batchId ? (
            <BatchResult batchId={batchId} refreshKey={job?.status ?? null} />
          ) : (
            !search.job && (
              <p className="text-sm text-muted-foreground">
                No nesting run yet. Validate a batch on the Sheets step and start nesting.
              </p>
            )
          )}
          {(isTerminal(job) || (!search.job && batchId)) && (
            <Button variant="outline" size="sm" className="self-start" onClick={startNew}>
              <FilePlus2 /> Start another batch
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
