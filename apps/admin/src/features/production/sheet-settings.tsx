import { memo, useState, type ReactNode } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Labelled, Section, Segmented, SelectField, SwitchField } from "../studio/components/fields";
import { createBatch, startNesting } from "./api";
import { marginsEqual } from "./batch-logic";
import type { BatchDraft, BatchRequest, ServiceResult, TimeBudget } from "./contracts";
import { DraftNumberField } from "./draft-field";
import { focusField } from "./focus";
import { attempt, useActionKey } from "./hooks";
import { ProductImage } from "./product-image";
import { actualSize } from "./sizing";
import { BatchBadge, ErrorText, ResultAlert, formatMm } from "./status";
import { MasterLoader } from "./trace-preview";
import {
  SHEET_PRESETS,
  useProduction,
  type BatchLine,
  type Margins,
  type SheetSettings as Settings,
} from "./store";
import {
  batchIssues,
  fitsSheet,
  sheetIssues,
  usableArea,
  type LineField,
  type SheetField,
} from "./validation";

function lineRequest(line: BatchLine): BatchRequest["lines"][number] {
  return {
    line_id: line.lineId,
    product_id: line.productId,
    master_id: line.masterId,
    size: {
      mode: line.mode,
      width_mm: line.mode === "height" ? null : line.width,
      height_mm: line.mode === "width" ? null : line.height,
    },
    quantity: line.quantity!,
    material: line.material,
    thickness_mm: line.thickness!,
    allowed_rotations: line.rotations,
    variant_id: null,
  };
}

function batchRequest(lines: BatchLine[], sheet: Settings): BatchRequest {
  const preset = sheet.preset === "custom" ? null : SHEET_PRESETS[sheet.preset];
  return {
    name: sheet.name.trim() || null,
    lines: lines.map(lineRequest),
    stock: {
      width_mm: sheet.width,
      height_mm: sheet.height,
      margins_mm: {
        left: sheet.margins.left!,
        right: sheet.margins.right!,
        bottom: sheet.margins.bottom!,
        top: sheet.margins.top!,
      },
      gap_mm: sheet.gap!,
      max_sheets: sheet.maxSheets!,
      label: preset?.label ?? `Custom · ${sheet.width} × ${sheet.height} mm`,
    },
    optimization: { time_budget_s: sheet.timeBudget, seed: sheet.seed },
    export: { chord_tolerance_mm: 0.05 },
  };
}

function Mm({
  field,
  label,
  value,
  onCommit,
  onDraft,
  disabled,
}: {
  field: SheetField;
  label: ReactNode;
  value: number | null;
  onCommit: (value: number | null) => void;
  onDraft?: (value: number | null | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <div data-sheet-field={field}>
      <DraftNumberField label={label} unit="mm" value={value} disabled={disabled} onCommit={onCommit} onDraft={onDraft} />
    </div>
  );
}

const SIDES = ["left", "right", "bottom", "top"] as const;
type Side = (typeof SIDES)[number];
const SIDE_LABELS: Record<Side, string> = { left: "Left", right: "Right", bottom: "Bottom", top: "Top" };

/** Products per material group, with their pictures so look-alike names can be told apart. */
const MaterialGroups = memo(function MaterialGroups({ lines }: { lines: BatchLine[] }) {
  const groups = new Map<string, { label: string; lines: BatchLine[]; parts: number }>();
  for (const line of lines) {
    if (!line.material || !line.thickness) continue;
    const key = `${line.material}|${line.thickness}`;
    const group = groups.get(key) ?? { label: `${line.material} · ${line.thickness} mm`, lines: [], parts: 0 };
    group.lines.push(line);
    group.parts += line.quantity ?? 0;
    groups.set(key, group);
  }
  if (!groups.size)
    return <p className="text-sm text-muted-foreground">Groups appear once lines have a material and thickness.</p>;
  return (
    <ul className="flex flex-wrap gap-2 text-sm">
      {[...groups.values()].map((group) => (
        <li key={group.label} className="flex max-w-md flex-col gap-2 rounded-lg border px-3 py-2">
          <div>
            <div className="font-medium">{group.label}</div>
            <div className="text-xs text-muted-foreground">
              {group.lines.length} line{group.lines.length === 1 ? "" : "s"} · {group.parts} parts · nested on separate
              sheets
            </div>
          </div>
          <ul className="flex flex-col gap-1">
            {group.lines.map((line) => (
              <li key={line.lineId} className="flex items-center gap-2 text-xs">
                <ProductImage thumbnail={line.thumbnail} masterId={line.masterId} name={line.productName} className="size-8" />
                <span className="min-w-0 flex-1 truncate">{line.productName}</span>
                <span className="text-muted-foreground tabular-nums">
                  {line.mode === "height" ? `H ${line.height ?? "—"}` : `W ${line.width ?? "—"}`} mm × {line.quantity ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
});

type Problem = { message: string; tone: "muted" | "error"; go?: () => void };

export function SheetSettings({
  canEdit,
  onStarted,
  onEditLine,
}: {
  canEdit: boolean;
  onStarted: (run: { jobId: string; batchId: string }) => void;
  /** Opens the Batch step with that row's field focused. */
  onEditLine: (lineId: string, field: LineField) => void;
}) {
  const sheet = useProduction((state) => state.sheet);
  const lines = useProduction((state) => state.lines);
  const masters = useProduction((state) => state.masters);
  const draft = useProduction((state) => state.draft);
  const { updateSheet, choosePreset, setDraft } = useProduction.getState();
  const validateKey = useActionKey("batch");
  const nestKey = useActionKey("nest");
  const [busy, setBusy] = useState<"validate" | "nest" | null>(null);
  const [failure, setFailure] = useState<ServiceResult<unknown> | null>(null);
  // Margins/gap being typed, so the usable area follows the keystrokes.
  const [typing, setTyping] = useState<Partial<Margins>>({});

  const preview = (side: Side | "all") => (value: number | null | undefined) =>
    setTyping((current) => {
      if (value === undefined) return {};
      return side === "all" ? { left: value, right: value, bottom: value, top: value } : { ...current, [side]: value };
    });
  const setMargin = (side: Side) => (value: number | null) =>
    updateSheet({ margins: { ...useProduction.getState().sheet.margins, [side]: value } });
  const setAllMargins = (value: number | null) =>
    updateSheet({ margins: { left: value, right: value, bottom: value, top: value } });
  const linkMargins = (linked: boolean) => {
    const { margins } = useProduction.getState().sheet;
    // Linking adopts the left margin the operator entered for all four sides.
    updateSheet(
      linked && !marginsEqual(margins)
        ? { linkMargins: true, margins: { left: margins.left, right: margins.left, bottom: margins.left, top: margins.left } }
        : { linkMargins: linked },
    );
  };

  const shown: Settings = { ...sheet, margins: { ...sheet.margins, ...typing } };
  const usable = usableArea(shown);
  const fitIssues = usable
    ? lines.flatMap((line) => {
        const master = masters[line.masterId];
        const size = master && actualSize(master.aspect_ratio, line);
        return size && !fitsSheet(size, line.rotations, usable)
          ? [
              {
                message: `${line.productName}: ${formatMm(size.width)} × ${formatMm(size.height)} mm does not fit the usable ${formatMm(usable.width)} × ${formatMm(usable.height)} mm area in any allowed rotation.`,
                tone: "error" as const,
                go: () => onEditLine(line.lineId, line.mode === "height" ? "height" : "width"),
              },
            ]
          : [];
      })
    : [];
  const problems: Problem[] = [
    ...(lines.length ? [] : [{ message: "Add at least one batch line.", tone: "muted" as const }]),
    ...batchIssues(lines, masters).map(({ lineId, productName, issue }) => ({
      message: `${productName}: ${issue.message}`,
      tone: "muted" as const,
      go: issue.field ? () => onEditLine(lineId, issue.field!) : undefined,
    })),
    ...sheetIssues(sheet).map((issue) => ({
      message: issue.message,
      tone: "muted" as const,
      go: issue.field ? () => focusField({ scope: "sheet", field: issue.field! }) : undefined,
    })),
  ];

  async function validate(): Promise<BatchDraft | null> {
    const { lines: current, sheet: settings } = useProduction.getState();
    const request = batchRequest(current, settings);
    setBusy("validate");
    const result = await attempt(() =>
      createBatch({ data: { request, idempotencyKey: validateKey.key(JSON.stringify(request)) } }),
    );
    validateKey.settle(result);
    setBusy(null);
    if (!result.ok) {
      setFailure(result);
      return null;
    }
    setDraft(result.data);
    return result.data;
  }

  async function nest(batchId: string) {
    setBusy("nest");
    const result = await attempt(() =>
      startNesting({ data: { batchId, idempotencyKey: nestKey.key(batchId) } }),
    );
    nestKey.settle(result);
    setBusy(null);
    // Only the service's acceptance (a job ID) counts as queued.
    if (result.ok) onStarted({ jobId: result.data.job_id, batchId });
    else setFailure(result);
  }

  /**
   * One action: check locally, have the service validate (unless this exact
   * batch was validated already), and start nesting when it is valid.
   * Reads the store at click time, so a value committed by leaving a field
   * (the click blurs it) is included.
   */
  async function run() {
    setFailure(null);
    const state = useProduction.getState();
    const firstLine = batchIssues(state.lines, state.masters)[0];
    if (firstLine?.issue.field) return onEditLine(firstLine.lineId, firstLine.issue.field);
    const firstSheet = sheetIssues(state.sheet)[0];
    if (firstSheet?.field) return void focusField({ scope: "sheet", field: firstSheet.field });
    if (!state.lines.length || firstLine || firstSheet) return;
    const validated = state.draft ?? (await validate());
    if (validated?.status === "draft") await nest(validated.batch_id);
  }

  return (
    <div className="flex min-h-0 flex-1">
      {[...new Set(lines.map((line) => line.masterId))].map((id) => (
        <MasterLoader key={id} masterId={id} />
      ))}
      <div className="w-96 shrink-0 overflow-y-auto border-r">
        <Section title="Stock sheet">
          <SelectField<Settings["preset"]>
            value={sheet.preset}
            options={[
              { value: "current", label: SHEET_PRESETS.current.label },
              { value: "future", label: SHEET_PRESETS.future.label },
              { value: "custom", label: "Custom size" },
            ]}
            onChange={choosePreset}
            aria-label="Sheet size"
          />
          {sheet.preset === "future" && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              The 2000 × 4000 mm machine is not installed yet. Do not use this size for present
              production.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Mm
              field="width"
              label="W"
              value={sheet.width}
              disabled={sheet.preset !== "custom"}
              onCommit={(width) => width != null && updateSheet({ width })}
            />
            <Mm
              field="height"
              label="H"
              value={sheet.height}
              disabled={sheet.preset !== "custom"}
              onCommit={(height) => height != null && updateSheet({ height })}
            />
          </div>
        </Section>
        <Section title="Margins and gap">
          <p className="text-xs text-muted-foreground">
            No workshop values are confirmed, so nothing is pre-filled. What you enter is remembered
            for this sheet size.
          </p>
          <SwitchField label="Same margin on all sides" checked={sheet.linkMargins} onChange={linkMargins} />
          {sheet.linkMargins ? (
            <Mm
              field="margins"
              label="Margin"
              value={marginsEqual(sheet.margins) ? sheet.margins.left : null}
              onDraft={preview("all")}
              onCommit={setAllMargins}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {SIDES.map((side) => (
                <Mm
                  key={side}
                  field={side}
                  label={SIDE_LABELS[side]}
                  value={sheet.margins[side]}
                  onDraft={preview(side)}
                  onCommit={setMargin(side)}
                />
              ))}
            </div>
          )}
          <Mm field="gap" label="Gap" value={sheet.gap} onCommit={(gap) => updateSheet({ gap })} />
          {usable && (
            <p className="text-xs text-muted-foreground tabular-nums">
              Usable area {formatMm(usable.width)} × {formatMm(usable.height)} mm
            </p>
          )}
        </Section>
        <Section title="Optimization">
          <div data-sheet-field="maxSheets">
            <DraftNumberField
              label="Max sheets"
              value={sheet.maxSheets}
              min={1}
              digits={0}
              onCommit={(maxSheets) => updateSheet({ maxSheets })}
            />
          </div>
          <Labelled label="Time budget per material group">
            <Segmented<`${TimeBudget}`>
              value={`${sheet.timeBudget}`}
              options={[
                { value: "10", label: "10 s" },
                { value: "30", label: "30 s" },
                { value: "120", label: "120 s" },
              ]}
              onChange={(value) => updateSheet({ timeBudget: Number(value) as TimeBudget })}
            />
          </Labelled>
          <DraftNumberField
            label="Seed"
            value={sheet.seed}
            digits={0}
            onCommit={(seed) => seed != null && Number.isInteger(seed) && seed >= 0 && updateSheet({ seed })}
          />
          <Labelled label="Batch name (optional)">
            <Input
              key={sheet.name}
              defaultValue={sheet.name}
              maxLength={120}
              onBlur={(event) => {
                if (event.target.value !== useProduction.getState().sheet.name) updateSheet({ name: event.target.value });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </Labelled>
        </Section>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Material groups</h3>
          <MaterialGroups lines={lines} />
          <p className="mt-2 text-xs text-muted-foreground">
            The sheet count is only known after nesting completes.
          </p>
        </div>

        {(problems.length > 0 || fitIssues.length > 0) && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Before running</h3>
            <ul className="list-disc pl-5 text-xs">
              {[...problems, ...fitIssues].map((problem) => (
                <li key={problem.message} className={problem.tone === "error" ? "text-destructive" : "text-muted-foreground"}>
                  {problem.go ? (
                    <button type="button" className="text-left underline-offset-2 hover:underline" onClick={problem.go}>
                      {problem.message}
                    </button>
                  ) : (
                    problem.message
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <ResultAlert result={failure} title="The service did not accept the request" />

        <div className="flex items-center gap-2">
          <Button disabled={!canEdit || busy != null} onClick={() => void run()}>
            {busy ? <Loader2 className="animate-spin" /> : <Play />}{" "}
            {busy === "validate" ? "Validating…" : busy === "nest" ? "Starting…" : "Run nesting"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Validates the batch with the service, then starts nesting if it is valid.
          </span>
        </div>

        {draft && (
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Batch {draft.batch_id}</span>
              <BatchBadge status={draft.status} />
            </div>
            <ul className="flex flex-col gap-1 text-xs">
              {draft.groups.map((group) => (
                <li key={group.group_key}>
                  {group.material} · {group.thickness_mm} mm — {group.line_ids.length} lines,{" "}
                  {group.instance_count} parts
                </li>
              ))}
            </ul>
            {draft.lines
              .filter((line) => !line.fits || line.errors.length)
              .map((line) => {
                const name = lines.find((entry) => entry.lineId === line.line_id)?.productName ?? line.line_id;
                return (
                  <div key={line.line_id}>
                    <button
                      type="button"
                      className="text-xs font-medium underline-offset-2 hover:underline"
                      onClick={() => onEditLine(line.line_id, "width")}
                    >
                      {name}
                    </button>
                    {line.errors.map((error, index) => (
                      <ErrorText key={index} error={error} />
                    ))}
                  </div>
                );
              })}
            {draft.status === "invalid" && (
              <p className="text-xs text-destructive">Fix the lines above, then run again.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
