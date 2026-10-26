import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Package,
  RefreshCw,
  Repeat2,
  SquareDashed,
  XCircle,
} from "lucide-react";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Toggle } from "@workspace/ui/components/toggle";
import { cn } from "@workspace/ui/lib/utils";
import { artifactUrl, getBatch } from "./api";
import { LIMITS } from "./batch-logic";
import type { Batch, JsonValue, Master, ServiceResult } from "./contracts";
import { attempt } from "./hooks";
import { ProductImage } from "./product-image";
import { useRepeatBatch } from "./repeat";
import {
  ENGINE_TEXT,
  formatArea,
  formatDuration,
  formatMm,
  formatPercent,
  groupSummaries,
  leftoverSummary,
  leftoverText,
  METAL_FREE_DEFINITION,
  USABLE_LEFTOVER_DEFINITION,
  partColour,
  plural,
  qualification,
  sheetNumbers,
  shortOfSheets,
  suggestedSheetLimit,
  type CheckState,
} from "./results-logic";
import { SheetViewport, type PartLook } from "./sheet-viewport";
import { actualSize, type SizeInput } from "./sizing";
import { BatchBadge, ResultAlert, formatDate } from "./status";
import { useProduction, type ProductInfo } from "./store";
import { MasterLoader } from "./trace-preview";

export function useBatch(batchId: string | null, refreshKey: unknown) {
  const [result, setResult] = useState<ServiceResult<Batch> | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!batchId) return;
    let active = true;
    void attempt(() => getBatch({ data: { id: batchId } })).then((next) => {
      if (active) setResult(next);
    });
    return () => {
      active = false;
    };
  }, [batchId, refreshKey, nonce]);
  return {
    result: result?.ok && result.data.batch_id !== batchId ? null : result,
    reload: () => setNonce((value) => value + 1),
  };
}

type FrozenLine = { lineId: string; productId: string; masterId: string; size: SizeInput; quantity: number | null };

/** Reads the frozen request's lines; the service echoes what the admin sent. */
function frozenLines(request: Batch["request"]): FrozenLine[] {
  const lines = request.lines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((raw): FrozenLine[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const size = raw.size && typeof raw.size === "object" && !Array.isArray(raw.size) ? raw.size : {};
    const num = (value: JsonValue | undefined) => (typeof value === "number" ? value : null);
    const mode = size.mode === "height" || size.mode === "fit" ? size.mode : "width";
    return typeof raw.line_id === "string" && typeof raw.master_id === "string"
      ? [
          {
            lineId: raw.line_id,
            productId: typeof raw.product_id === "string" ? raw.product_id : "",
            masterId: raw.master_id,
            size: { mode, width: num(size.width_mm), height: num(size.height_mm) },
            quantity: num(raw.quantity),
          },
        ]
      : [];
  });
}

function marginsOf(request: Batch["request"]) {
  const stock = request.stock;
  if (!stock || typeof stock !== "object" || Array.isArray(stock)) return null;
  const margins = stock.margins_mm;
  if (!margins || typeof margins !== "object" || Array.isArray(margins)) return null;
  const { left, right, bottom, top } = margins;
  return typeof left === "number" && typeof right === "number" && typeof bottom === "number" && typeof top === "number"
    ? { left, right, bottom, top }
    : null;
}

/**
 * Name and picture of a frozen line, by its product id; the batch may be
 * older than this browser's rows, so it never depends on the current lines.
 */
function describe(line: FrozenLine, products: Record<string, ProductInfo>, master: Master | undefined) {
  const known = products[line.productId];
  return {
    name: known?.name ?? (master ? `Product traced as master r${master.revision}` : "Product from an earlier batch"),
    thumbnail: known?.thumbnail ?? null,
  };
}

function countBy(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function Swatch({ colour }: { colour: string }) {
  return <span className="size-3 shrink-0" style={{ background: colour }} aria-hidden />;
}

const STATE_ICON: Record<CheckState, ReactNode> = {
  good: <CheckCircle2 className="size-4 shrink-0 text-ws-cut" aria-label="Done" />,
  attention: <AlertTriangle className="size-4 shrink-0 text-ws-hazard-ink" aria-label="Needs checking" />,
  blocked: <XCircle className="size-4 shrink-0 text-ws-spark" aria-label="Blocked" />,
  pending: <RefreshCw className="size-4 shrink-0 text-muted-foreground" aria-label="Pending" />,
};

function Check({ state, title, children }: { state: CheckState; title: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex gap-2 border-l-4 py-1.5 pr-1 pl-2",
        state === "good" && "border-l-ws-cut",
        state === "attention" && "border-l-ws-hazard bg-ws-hazard/10",
        state === "blocked" && "border-l-ws-spark bg-ws-spark/10",
        state === "pending" && "border-l-border",
      )}
    >
      {STATE_ICON[state]}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <div className="text-xs text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

/** A rail section: a plain heading over ruled content, no card chrome. */
function Block({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0", className)}>
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Figure({ value, label, tone }: { value: ReactNode; label: string; tone?: "bad" }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={cn("ws-numeral text-[28px] tracking-wide", tone === "bad" && "text-ws-spark")}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function SheetPreview({
  batch,
  onReload,
  onOpenDraft,
  draftRows,
}: {
  batch: Batch;
  onReload: () => void;
  onOpenDraft: () => void;
  draftRows: number;
}) {
  const masters = useProduction((state) => state.masters);
  const products = useProduction((state) => state.products);
  const [active, setActive] = useState(batch.sheets[0]?.sheet_id ?? "");
  const [boxes, setBoxes] = useState(false);
  const { repeat, dialog, problem } = useRepeatBatch();

  const lines = useMemo(() => frozenLines(batch.request), [batch.request]);
  const numbers = useMemo(() => sheetNumbers(batch.sheets), [batch.sheets]);
  const serviceLines = useMemo(() => new Map(batch.lines.map((line) => [line.line_id, line])), [batch.lines]);
  const colours = useMemo(() => new Map(lines.map((line, index) => [line.lineId, partColour(index)])), [lines]);
  const info = useMemo(
    () => new Map(lines.map((line) => [line.lineId, describe(line, products, masters[line.masterId])])),
    [lines, products, masters],
  );
  const looks = useMemo(() => {
    const result = new Map<string, PartLook>();
    for (const line of lines) {
      const master = masters[line.masterId];
      const service = serviceLines.get(line.lineId);
      // The service's own sized dimensions win over a local recomputation.
      const size =
        service?.actual_width_mm != null && service.actual_height_mm != null
          ? { width: service.actual_width_mm, height: service.actual_height_mm }
          : master
            ? actualSize(master.aspect_ratio, line.size)
            : null;
      if (!size) continue;
      result.set(line.lineId, {
        name: info.get(line.lineId)?.name ?? "Part",
        colour: colours.get(line.lineId) ?? partColour(0),
        width: size.width,
        height: size.height,
        mask: master?.artifacts.master_svg ? artifactUrl(master.artifacts.master_svg) : null,
      });
    }
    return result;
  }, [lines, masters, serviceLines, colours, info]);

  const margins = marginsOf(batch.request);
  const sheet = batch.sheets.find((entry) => entry.sheet_id === active) ?? batch.sheets[0];
  const sheetNumber = sheet ? (numbers.get(sheet.sheet_id) ?? 1) : 0;
  const files = batch.artifacts.sheets.find((entry) => entry.sheet_id === sheet?.sheet_id);
  const totals = batch.totals;
  const placedCounts = useMemo(
    () => countBy(batch.sheets.flatMap((entry) => entry.placements.map((placement) => placement.line_id))),
    [batch.sheets],
  );
  const checks = qualification(batch);
  const groups = useMemo(() => groupSummaries(batch), [batch]);
  const traceWarnings = lines.flatMap((line) =>
    (masters[line.masterId]?.diagnostics.warnings ?? []).map((warning) => ({
      lineId: line.lineId,
      text: `${info.get(line.lineId)?.name}: ${warning.message || warning.code}`,
    })),
  );
  const uniqueWarnings = [...new Map(traceWarnings.map((warning) => [warning.text, warning])).values()];
  // Name the affected parts only when it is some of them, not all.
  const affected =
    checks.features.state !== "good" && checks.features.lineIds.length < lines.length
      ? checks.features.lineIds.flatMap((id) => info.get(id)?.name ?? [])
      : [];
  const short = shortOfSheets(batch);
  const nextLimit = short ? suggestedSheetLimit(batch, LIMITS.maxSheets) : null;
  const sheetGroup = groups.find((group) => group.groupKey === sheet?.group_key);
  const sheetMetrics = sheet?.metrics ?? {};
  const sheetUtil = typeof sheetMetrics.utilization === "number" ? sheetMetrics.utilization : null;
  const leftover = leftoverSummary(batch, groups);
  // While the job runs, every rail section is already in place with a short
  // note, so finishing fills them in without moving the ones below.
  const pendingRun = batch.status === "queued" || batch.status === "nesting";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
      {[...new Set(lines.map((line) => line.masterId))].map((id) => (
        <MasterLoader key={id} masterId={id} />
      ))}
      {dialog}

      <div className="flex min-h-[420px] min-w-0 flex-1 flex-col gap-2">
        <header className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold" title={batch.batch_id}>
                {batch.name ?? "Untitled batch"}
              </h2>
              <BatchBadge status={batch.status} />
              <Button variant="ghost" size="icon-sm" aria-label="Reload batch" onClick={onReload}>
                <RefreshCw />
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              {batch.created_at ? `Created ${formatDate(batch.created_at)}` : `Batch ${batch.batch_id}`}
            </span>
          </div>
          {totals && (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <Figure
                value={`${totals.placed}/${totals.requested}`}
                label="parts placed"
                tone={totals.unplaced ? "bad" : undefined}
              />
              <Figure value={totals.sheet_count} label={totals.sheet_count === 1 ? "sheet" : "sheets"} />
              <Figure value={formatPercent(totals.utilization)} label="metal coverage" />
              {totals.runtime_s != null && <Figure value={formatDuration(totals.runtime_s)} label="solver time" />}
            </div>
          )}
        </header>

        <div className="flex flex-wrap items-center gap-2">
          {batch.sheets.length > 0 && (
            <div role="tablist" aria-label="Sheets" className="flex max-w-full gap-1 overflow-x-auto">
              {batch.sheets.map((entry) => {
                const number = numbers.get(entry.sheet_id) ?? 0;
                const selected = entry.sheet_id === sheet?.sheet_id;
                return (
                  <button
                    key={entry.sheet_id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-label={`Sheet ${number}`}
                    onClick={() => setActive(entry.sheet_id)}
                    className={cn(
                      "flex shrink-0 items-baseline gap-1 border-b-2 px-2 pt-1 pb-0.5 text-xs text-muted-foreground hover:text-foreground",
                      selected ? "border-ws-temper text-foreground" : "border-transparent",
                    )}
                  >
                    Sheet <span className="ws-numeral text-lg">{number}</span>
                  </button>
                );
              })}
            </div>
          )}
          <span className="flex-1" />
          <Toggle
            variant="outline"
            size="sm"
            pressed={boxes}
            onPressedChange={setBoxes}
            aria-label="Show bounding-box guides"
          >
            <SquareDashed /> Box guides
          </Toggle>
        </div>

        {sheet ? (
          <SheetViewport
            key={sheet.sheet_id}
            sheet={sheet}
            label={`Sheet ${sheetNumber}, ${plural(sheet.placements.length, "part")}`}
            looks={looks}
            margins={margins}
            boxes={boxes}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center border bg-ws-surface p-6 text-center text-sm text-muted-foreground">
            {batch.status === "queued" || batch.status === "nesting"
              ? "Sheets appear here when nesting finishes."
              : "No sheets were laid out for this batch."}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Real cut outlines, coloured by product. The dashed line is the sheet margin; guides never appear in the DXF.
        </p>
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:w-[17rem] xl:w-80">
        <Block title="Ready to cut?">
          <Check state={checks.geometry.state} title={checks.geometry.title}>
            {checks.geometry.detail}
          </Check>
          {batch.sheets.length > 0 ? (
            <Check state={checks.features.state} title={checks.features.title}>
              {checks.features.detail}
              {affected.length > 0 && <> Affects {affected.join(", ")}.</>}
            </Check>
          ) : (
            pendingRun && (
              <Check state="pending" title="Feature widths">
                Checked against the fabrication profile when nesting finishes.
              </Check>
            )
          )}
          {uniqueWarnings.length > 0 && (
            <Check state="attention" title={`${plural(uniqueWarnings.length, "tracing warning")}`}>
              <ul className="flex flex-col gap-0.5">
                {uniqueWarnings.slice(0, 6).map((warning) => (
                  <li key={warning.text}>{warning.text}</li>
                ))}
              </ul>
            </Check>
          )}
          {short && nextLimit != null && (
            <Button onClick={() => repeat(batch, { maxSheets: nextLimit, run: true })}>
              <Repeat2 /> Raise limit to {nextLimit} sheets and retry
            </Button>
          )}
        </Block>

        <Block title="Files">
          {batch.status === "completed" && !checks.readyToCut && (
            <p className="text-xs text-ws-hazard-ink">
              The files are geometrically complete. Check the points above before cutting.
            </p>
          )}
          {batch.artifacts.zip && (
            <a href={artifactUrl(batch.artifacts.zip)} download className={buttonVariants()}>
              <Package /> Download all sheets (ZIP)
            </a>
          )}
          {sheet && (files?.dxf || files?.svg) && (
            <div className="flex flex-wrap gap-2">
              {files?.dxf && (
                <a href={artifactUrl(files.dxf)} download className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <Download /> Sheet {sheetNumber} DXF
                </a>
              )}
              {files?.svg && (
                <a href={artifactUrl(files.svg)} download className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  <Download /> Sheet {sheetNumber} preview SVG
                </a>
              )}
            </div>
          )}
          {batch.artifacts.manifest && (
            <a
              href={artifactUrl(batch.artifacts.manifest)}
              download
              className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
            >
              <FileText /> Manifest (JSON)
            </a>
          )}
          {pendingRun && (
            <>
              <Button disabled>
                <Package /> Download all sheets (ZIP)
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled>
                  <Download /> Sheet 1 DXF
                </Button>
                <Button variant="ghost" size="sm" disabled>
                  <Download /> Sheet 1 preview SVG
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Files are written and checked when nesting finishes.</p>
            </>
          )}
          {!batch.artifacts.zip && batch.status !== "completed" && !pendingRun && (
            <p className="text-xs text-muted-foreground">No production files are offered for an unfinished or partial batch.</p>
          )}
        </Block>

        {!sheet && pendingRun && (
          <Block title="Sheet 1">
            <p className="text-xs text-muted-foreground">Sheet size and the parts on it appear when nesting finishes.</p>
          </Block>
        )}
        {sheet && (
          <Block title={`Sheet ${sheetNumber} of ${batch.sheets.length}`}>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatMm(sheet.width_mm)} × {formatMm(sheet.height_mm)} mm{sheetGroup ? `, ${sheetGroup.label}` : ""}
              {sheetUtil != null ? `, ${formatPercent(sheetUtil)} covered by parts` : ""}
            </p>
            <ul className="flex flex-col gap-1 text-xs">
              {[...countBy(sheet.placements.map((placement) => placement.line_id))].map(([lineId, count]) => (
                <li key={lineId} className="flex items-center gap-2">
                  <Swatch colour={colours.get(lineId) ?? partColour(0)} />
                  <span className="min-w-0 flex-1 truncate">{info.get(lineId)?.name ?? "Part"}</span>
                  <span className="tabular-nums">× {count}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {batch.sheets.length > 0 && groups.length > 0 && (
          <Block title={groups.length === 1 ? "How it was nested" : "How each material group was nested"}>
            <ul className="flex flex-col gap-3 text-xs">
              {groups.map((group) => {
                const engine = ENGINE_TEXT[group.engine];
                const range =
                  group.sheetNumbers.length > 1
                    ? `sheets ${group.sheetNumbers[0]}–${group.sheetNumbers[group.sheetNumbers.length - 1]}`
                    : group.sheetNumbers.length === 1
                      ? `sheet ${group.sheetNumbers[0]}`
                      : "no sheets";
                return (
                  <li key={group.groupKey} className="flex flex-col gap-1">
                    <span className="font-medium text-foreground">
                      {group.label}, {range}
                    </span>
                    <span className={cn(group.engine === "bbox" && "text-ws-hazard-ink")}>
                      <span className="font-medium">{engine.label}</span>
                      {group.engineVersion ? ` ${group.engineVersion}` : ""}
                      {group.runtimeS != null ? `, ${formatDuration(group.runtimeS)}` : ""}. {engine.detail}
                    </span>
                    {leftoverText(group) && <span className="text-muted-foreground">{leftoverText(group)}</span>}
                  </li>
                );
              })}
            </ul>
          </Block>
        )}

        {pendingRun && !batch.sheets.length && (
          <Block title="How it was nested">
            <p className="text-xs text-muted-foreground">The engine used and the leftover stock appear when nesting finishes.</p>
          </Block>
        )}

        {(leftover.usableMm2 != null || leftover.metalFreeMm2 != null) && (
          <Block title="Leftover stock">
            <dl className="flex flex-col gap-2 text-xs">
              {leftover.usableMm2 != null && (
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="font-medium text-foreground">Usable leftover</dt>
                    <dd className="tabular-nums font-medium text-foreground">{formatArea(leftover.usableMm2)}</dd>
                  </div>
                  <p className="text-muted-foreground">{USABLE_LEFTOVER_DEFINITION}</p>
                  {groups.length > 1 && (
                    <ul className="flex flex-col gap-0.5 text-muted-foreground">
                      {groups.map((group) => (
                        <li key={group.groupKey} className="flex justify-between gap-2">
                          <span className="truncate">{group.label}</span>
                          <span className="tabular-nums">
                            {group.usableLeftoverMm2 != null ? formatArea(group.usableLeftoverMm2) : "not reported"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {leftover.metalFreeMm2 != null && (
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="font-medium text-foreground">Metal-free area</dt>
                    <dd className="tabular-nums">{formatArea(leftover.metalFreeMm2)}</dd>
                  </div>
                  <p className="text-muted-foreground">{METAL_FREE_DEFINITION}</p>
                </div>
              )}
            </dl>
          </Block>
        )}

        {lines.length > 0 && (
          <Block title="Parts">
            <ul className="flex flex-col gap-1.5 text-xs">
              {lines.map((line) => {
                const look = looks.get(line.lineId);
                const placed = placedCounts.get(line.lineId) ?? 0;
                const feature = serviceLines.get(line.lineId)?.feature_check;
                const name = info.get(line.lineId)?.name ?? "Part";
                return (
                  <li key={line.lineId} className="flex items-center gap-2">
                    <Swatch colour={colours.get(line.lineId) ?? partColour(0)} />
                    <ProductImage
                      thumbnail={info.get(line.lineId)?.thumbnail ?? null}
                      masterId={line.masterId}
                      name={name}
                      className="size-9"
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium" title={name}>
                        {name}
                      </span>
                      {look && (
                        <span className="text-muted-foreground tabular-nums">
                          {formatMm(look.width)} × {formatMm(look.height)} mm
                          {feature?.status === "fail" ? ", features too thin" : ""}
                        </span>
                      )}
                    </div>
                    <span
                      className={cn("tabular-nums", line.quantity != null && placed < line.quantity && "text-ws-spark")}
                      title="Placed of requested"
                    >
                      {placed}
                      {line.quantity != null && ` of ${line.quantity}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Block>
        )}

        <Block title="Next">
          <Button variant="outline" onClick={() => repeat(batch)}>
            <Repeat2 /> Repeat this batch
          </Button>
          <Button variant="ghost" onClick={onOpenDraft}>
            {draftRows ? `Open current draft (${plural(draftRows, "row")})` : "Start a new batch"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Repeat loads this batch's exact rows and sheet settings into a new draft. The current draft is kept until
            you confirm.
          </p>
          {problem && <p className="text-xs text-ws-spark">{problem}</p>}
        </Block>
      </aside>
    </div>
  );
}

export function BatchResult({
  batchId,
  refreshKey,
  onOpenDraft,
}: {
  batchId: string;
  refreshKey: unknown;
  onOpenDraft: () => void;
}) {
  const { result, reload } = useBatch(batchId, refreshKey);
  const draftRows = useProduction((state) => state.lines.length);
  if (!result)
    return (
      <div className="flex min-h-0 flex-1 gap-3" aria-busy="true" aria-label="Loading batch">
        <div className="min-h-[420px] flex-1 animate-pulse bg-ws-surface" />
        <div className="hidden w-80 flex-col gap-3 lg:flex">
          <div className="h-24 animate-pulse bg-muted" />
          <div className="h-16 animate-pulse bg-muted" />
          <div className="h-40 animate-pulse bg-muted" />
        </div>
      </div>
    );
  if (!result.ok) return <ResultAlert result={result} title="Batch unavailable" />;
  return (
    <SheetPreview
      key={result.data.batch_id}
      batch={result.data}
      onReload={reload}
      onOpenDraft={onOpenDraft}
      draftRows={draftRows}
    />
  );
}
