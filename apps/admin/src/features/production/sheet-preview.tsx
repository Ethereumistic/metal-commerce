import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { Download, Maximize2, Minus, Package, Plus, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { Segmented } from "../studio/components/fields";
import { artifactUrl, getBatch } from "./api";
import type { Batch, JsonValue, ServiceResult, Sheet } from "./contracts";
import { attempt } from "./hooks";
import { actualSize, type SizeInput } from "./sizing";
import { BatchBadge, ResultAlert, formatMm } from "./status";
import { useProduction } from "./store";
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

type FrozenLine = { lineId: string; productId: string; masterId: string; size: SizeInput };

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
          },
        ]
      : [];
  });
}

const hue = (index: number) => (index * 137.508) % 360;

type Box = { x: number; y: number; w: number; h: number };

/** Sheet layout with wheel zoom, drag pan and fit-to-view. Coordinates are mm. */
function ZoomPan({ sheet, children }: { sheet: { width: number; height: number }; children: ReactNode }) {
  const pad = Math.max(sheet.width, sheet.height) * 0.03;
  const fit = useMemo<Box>(
    () => ({ x: -pad, y: -pad, w: sheet.width + pad * 2, h: sheet.height + pad * 2 }),
    [sheet.width, sheet.height, pad],
  );
  const [view, setView] = useState<Box>(fit);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: Box } | null>(null);
  useEffect(() => setView(fit), [fit]);

  const zoom = (factor: number, center?: { x: number; y: number }) =>
    setView((current) => {
      const cx = center?.x ?? current.x + current.w / 2;
      const cy = center?.y ?? current.y + current.h / 2;
      const w = Math.min(Math.max(current.w * factor, fit.w / 50), fit.w * 4);
      const h = (w / current.w) * current.h;
      return { x: cx - ((cx - current.x) * w) / current.w, y: cy - ((cy - current.y) * h) / current.h, w, h };
    });

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svg.current!.getBoundingClientRect();
    const scale = Math.max(view.w / rect.width, view.h / rect.height);
    // preserveAspectRatio xMidYMid meet: the view box is centred in the element.
    const offsetX = (rect.width * scale - view.w) / 2;
    const offsetY = (rect.height * scale - view.h) / 2;
    return {
      x: view.x - offsetX + (clientX - rect.left) * scale,
      y: view.y - offsetY + (clientY - rect.top) * scale,
      scale,
    };
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/30">
      <svg
        ref={svg}
        className="size-full cursor-grab touch-none select-none active:cursor-grabbing"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onWheel={(event: WheelEvent) => {
          const point = toWorld(event.clientX, event.clientY);
          zoom(event.deltaY > 0 ? 1.15 : 1 / 1.15, point);
        }}
        onPointerDown={(event: PointerEvent<SVGSVGElement>) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, view };
        }}
        onPointerMove={(event: PointerEvent<SVGSVGElement>) => {
          const start = drag.current;
          if (!start) return;
          const { scale } = toWorld(event.clientX, event.clientY);
          setView({
            ...start.view,
            x: start.view.x - (event.clientX - start.x) * scale,
            y: start.view.y - (event.clientY - start.y) * scale,
          });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {children}
      </svg>
      <div className="absolute top-2 right-2 flex gap-1">
        <Button variant="outline" size="icon-sm" aria-label="Zoom in" onClick={() => zoom(1 / 1.4)}>
          <Plus />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Zoom out" onClick={() => zoom(1.4)}>
          <Minus />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Fit sheet" onClick={() => setView(fit)}>
          <Maximize2 />
        </Button>
      </div>
    </div>
  );
}

type Sizes = Map<string, { width: number; height: number }>;

/**
 * Placements drawn as each part's bounding box at its placed rotation, from
 * the service's coordinates (sheet lower-left origin, Y up). True contours
 * are in the rendered SVG and the DXF.
 */
function PlacementLayer({
  sheet,
  sizes,
  colours,
  margins,
}: {
  sheet: Sheet;
  sizes: Sizes;
  colours: Map<string, number>;
  margins: { left: number; right: number; bottom: number; top: number } | null;
}) {
  const stroke = Math.max(sheet.width_mm, sheet.height_mm) / 800;
  const font = Math.max(sheet.width_mm, sheet.height_mm) / 90;
  return (
    <>
      <rect
        width={sheet.width_mm}
        height={sheet.height_mm}
        fill="var(--background)"
        stroke="var(--foreground)"
        strokeWidth={stroke * 2}
      />
      {margins && (
        <rect
          x={margins.left}
          y={margins.top}
          width={sheet.width_mm - margins.left - margins.right}
          height={sheet.height_mm - margins.bottom - margins.top}
          fill="none"
          stroke="var(--muted-foreground)"
          strokeDasharray={`${stroke * 6} ${stroke * 4}`}
          strokeWidth={stroke}
        />
      )}
      {/* Flip to the service's Y-up frame for the parts. */}
      <g transform={`translate(0 ${sheet.height_mm}) scale(1 -1)`}>
        {sheet.placements.map((placement) => {
          const size = sizes.get(placement.line_id);
          const colour = hue(colours.get(placement.line_id) ?? 0);
          if (!size)
            return (
              <circle
                key={placement.instance_id}
                cx={placement.tx_mm}
                cy={placement.ty_mm}
                r={font / 2}
                fill={`hsl(${colour} 70% 50%)`}
              />
            );
          return (
            <g
              key={placement.instance_id}
              transform={`translate(${placement.tx_mm} ${placement.ty_mm}) rotate(${placement.rotation_deg})`}
            >
              <rect
                width={size.width}
                height={size.height}
                fill={`hsl(${colour} 70% 55% / 0.25)`}
                stroke={`hsl(${colour} 70% 40%)`}
                strokeWidth={stroke}
              >
                <title>{`${placement.instance_id} · ${placement.rotation_deg}°`}</title>
              </rect>
            </g>
          );
        })}
      </g>
      {sheet.placements.map((placement) => {
        const size = sizes.get(placement.line_id);
        if (!size) return null;
        const angle = (placement.rotation_deg * Math.PI) / 180;
        const cx = placement.tx_mm + (size.width / 2) * Math.cos(angle) - (size.height / 2) * Math.sin(angle);
        const cy = placement.ty_mm + (size.width / 2) * Math.sin(angle) + (size.height / 2) * Math.cos(angle);
        return (
          <text
            key={placement.instance_id}
            x={cx}
            y={sheet.height_mm - cy}
            fontSize={font}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--foreground)"
            className="pointer-events-none"
          >
            {placement.instance_id.split("#").pop()}
          </text>
        );
      })}
    </>
  );
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

function validationNotes(validation: JsonValue): string[] {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return [];
  const notes: string[] = [];
  for (const key of ["errors", "warnings"] as const) {
    const entries = validation[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries)
      notes.push(
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.message === "string"
            ? `${typeof entry.code === "string" ? `${entry.code} · ` : ""}${entry.message}`
            : JSON.stringify(entry),
      );
  }
  return notes;
}

function MetricList({ metrics }: { metrics: Sheet["metrics"] }) {
  const entries = Object.entries(metrics).filter(
    (entry): entry is [string, number | string] =>
      typeof entry[1] === "number" || typeof entry[1] === "string",
  );
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key.replaceAll("_", " ")}</dt>
          <dd className="tabular-nums">
            {typeof value === "number" ? Number(value.toFixed(4)) : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SheetPreview({ batch, onReload }: { batch: Batch; onReload: () => void }) {
  const masters = useProduction((state) => state.masters);
  const names = useProduction((state) => state.lines);
  const [active, setActive] = useState(batch.sheets[0]?.sheet_id ?? "");
  const [view, setView] = useState<"layout" | "rendered">("layout");
  const lines = useMemo(() => frozenLines(batch.request), [batch.request]);
  const colours = useMemo(() => new Map(lines.map((line, index) => [line.lineId, index])), [lines]);
  const sizes = useMemo(() => {
    const result: Sizes = new Map();
    for (const line of lines) {
      const master = masters[line.masterId];
      const size = master && actualSize(master.aspect_ratio, line.size);
      if (size) result.set(line.lineId, size);
    }
    return result;
  }, [lines, masters]);
  const margins = marginsOf(batch.request);
  const sheet = batch.sheets.find((entry) => entry.sheet_id === active) ?? batch.sheets[0];
  const files = batch.artifacts.sheets.find((entry) => entry.sheet_id === sheet?.sheet_id);
  const notes = validationNotes(batch.validation);
  const totals = batch.totals;
  const nameOf = (lineId: string) =>
    names.find((line) => line.lineId === lineId)?.productName ?? lineId;

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {[...new Set(lines.map((line) => line.masterId))].map((id) => (
        <MasterLoader key={id} masterId={id} />
      ))}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          {batch.sheets.length > 0 && (
            <Tabs value={sheet?.sheet_id} onValueChange={(value) => setActive(String(value))}>
              <TabsList>
                {batch.sheets.map((entry) => (
                  <TabsTrigger key={entry.sheet_id} value={entry.sheet_id}>
                    Sheet {entry.index + 1}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <span className="flex-1" />
          <Segmented
            className="w-auto"
            value={view}
            options={[
              { value: "layout", label: "Layout" },
              { value: "rendered", label: "Rendered contours" },
            ]}
            onChange={setView}
          />
        </div>
        {sheet ? (
          view === "rendered" && files?.svg ? (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border bg-white">
              <img
                src={artifactUrl(files.svg)}
                alt={`Rendered sheet ${sheet.index + 1}`}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : (
            <ZoomPan sheet={{ width: sheet.width_mm, height: sheet.height_mm }}>
              <PlacementLayer sheet={sheet} sizes={sizes} colours={colours} margins={margins} />
            </ZoomPan>
          )
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border text-sm text-muted-foreground">
            No sheets yet.
          </div>
        )}
        {view === "layout" && (
          <p className="text-xs text-muted-foreground">
            Boxes are each part's bounding box at its placed rotation; the dashed line is the margin.
            Preview guides never appear in the DXF. Switch to Rendered contours for the real outlines.
          </p>
        )}
      </div>

      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">Batch {batch.batch_id}</span>
          <BatchBadge status={batch.status} />
          <Button variant="ghost" size="icon-sm" aria-label="Reload batch" onClick={onReload}>
            <RefreshCw />
          </Button>
        </div>
        {totals && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Requested</dt>
            <dd className="tabular-nums">{totals.requested}</dd>
            <dt className="text-muted-foreground">Placed</dt>
            <dd className="tabular-nums">{totals.placed}</dd>
            <dt className="text-muted-foreground">Unplaced</dt>
            <dd className={totals.unplaced ? "text-destructive tabular-nums" : "tabular-nums"}>{totals.unplaced}</dd>
            <dt className="text-muted-foreground">Sheets</dt>
            <dd className="tabular-nums">{totals.sheet_count}</dd>
            <dt className="text-muted-foreground">Utilization</dt>
            <dd className="tabular-nums">{(totals.utilization * 100).toFixed(1)}%</dd>
            <dt className="text-muted-foreground">Runtime</dt>
            <dd className="tabular-nums">{totals.runtime_s != null ? `${totals.runtime_s.toFixed(1)} s` : "—"}</dd>
            {totals.optimization_status && (
              <>
                <dt className="text-muted-foreground">Optimizer</dt>
                <dd>{totals.optimization_status}</dd>
              </>
            )}
          </dl>
        )}
        <p className="text-xs text-muted-foreground">
          Utilization is the metal area of the placed parts divided by the area of the sheets used,
          as computed by the service
          {totals
            ? `: ${formatMm(totals.metal_area_mm2 / 1e6)} m² of ${formatMm(totals.sheet_area_mm2 / 1e6)} m².`
            : "."}
        </p>
        {batch.status === "incomplete" && (
          <p className="text-xs text-destructive">
            Not every part was placed. No complete package is offered for a partial result.
          </p>
        )}
        {notes.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-400">
            {notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
        {sheet && (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Sheet {sheet.index + 1} · {formatMm(sheet.width_mm)} × {formatMm(sheet.height_mm)} mm
            </h4>
            <p className="text-xs text-muted-foreground">{sheet.group_key}</p>
            <ul className="text-xs">
              {[...countBy(sheet.placements.map((placement) => placement.line_id))].map(([lineId, count]) => (
                <li key={lineId} className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-sm"
                    style={{ background: `hsl(${hue(colours.get(lineId) ?? 0)} 70% 50%)` }}
                  />
                  <span className="min-w-0 flex-1 truncate">{nameOf(lineId)}</span>
                  <span className="tabular-nums">× {count}</span>
                </li>
              ))}
            </ul>
            <MetricList metrics={sheet.metrics} />
            <div className="flex flex-wrap gap-2">
              {files?.dxf && (
                <a href={artifactUrl(files.dxf)} download className={buttonVariants({ size: "sm" })}>
                  <Download /> Sheet DXF
                </a>
              )}
              {files?.svg && (
                <a
                  href={artifactUrl(files.svg)}
                  download
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <Download /> SVG
                </a>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {batch.status === "completed" && batch.artifacts.zip && (
            <a href={artifactUrl(batch.artifacts.zip)} download className={buttonVariants()}>
              <Package /> Download all (ZIP)
            </a>
          )}
          {batch.artifacts.manifest && (
            <a
              href={artifactUrl(batch.artifacts.manifest)}
              download
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Download /> Manifest
            </a>
          )}
        </div>
      </aside>
    </div>
  );
}

function countBy(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function BatchResult({ batchId, refreshKey }: { batchId: string; refreshKey: unknown }) {
  const { result, reload } = useBatch(batchId, refreshKey);
  if (!result) return <p className="text-sm text-muted-foreground">Loading batch…</p>;
  if (!result.ok) return <ResultAlert result={result} title="Batch unavailable" />;
  return <SheetPreview key={result.data.batch_id} batch={result.data} onReload={reload} />;
}
