import { useState } from "react";
import { Loader2, Play, ShieldCheck } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { NumberField } from "@workspace/ui/components/number-field";
import { Labelled, Section, Segmented, SelectField } from "../studio/components/fields";
import { createBatch, startNesting } from "./api";
import type { BatchRequest, Master, ServiceResult, TimeBudget } from "./contracts";
import { attempt, useActionKey } from "./hooks";
import { lineProblems } from "./batch-editor";
import { actualSize } from "./sizing";
import { BatchBadge, ErrorText, ResultAlert, formatMm } from "./status";
import { MasterLoader } from "./trace-preview";
import {
  SHEET_PRESETS,
  useProduction,
  type BatchLine,
  type SheetPreset,
  type SheetSettings as Settings,
} from "./store";

type Usable = { width: number; height: number };

function usableArea(sheet: Settings): Usable | null {
  const { left, right, bottom, top } = sheet.margins;
  if (left == null || right == null || bottom == null || top == null) return null;
  return { width: sheet.width - left - right, height: sheet.height - bottom - top };
}

/** Whether one part fits the usable area in any allowed orientation (no gap applies to a lone part). */
function fitsSheet(size: { width: number; height: number }, rotations: number[], usable: Usable) {
  const upright = rotations.some((rotation) => rotation % 180 === 0);
  const turned = rotations.some((rotation) => rotation % 180 !== 0);
  return (
    (upright && size.width <= usable.width && size.height <= usable.height) ||
    (turned && size.height <= usable.width && size.width <= usable.height)
  );
}

function sheetProblems(sheet: Settings): string[] {
  const problems: string[] = [];
  const { left, right, bottom, top } = sheet.margins;
  if ([left, right, bottom, top].some((value) => value == null))
    problems.push("Enter all four sheet margins (0 is allowed, but must be entered).");
  if (sheet.gap == null) problems.push("Enter the minimum gap between parts.");
  if (!sheet.maxSheets || !Number.isInteger(sheet.maxSheets) || sheet.maxSheets < 1)
    problems.push("Maximum sheets must be a whole number of at least 1.");
  if (!(sheet.width > 0) || !(sheet.height > 0)) problems.push("Enter the sheet size.");
  const usable = usableArea(sheet);
  if (usable && (usable.width <= 0 || usable.height <= 0)) problems.push("The margins leave no usable area.");
  return problems;
}

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
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <NumberField
      label={label}
      unit="mm"
      value={value}
      min={0}
      step={1}
      smallStep={0.1}
      largeStep={10}
      disabled={disabled}
      format={{ maximumFractionDigits: 2, useGrouping: false }}
      onValueChange={(next) => onChange(next != null && Number.isFinite(next) ? next : null)}
    />
  );
}

export function SheetSettings({
  canEdit,
  onStarted,
}: {
  canEdit: boolean;
  onStarted: (run: { jobId: string; batchId: string }) => void;
}) {
  const sheet = useProduction((state) => state.sheet);
  const lines = useProduction((state) => state.lines);
  const masters = useProduction((state) => state.masters);
  const draft = useProduction((state) => state.draft);
  const { updateSheet, setDraft } = useProduction.getState();
  const validateKey = useActionKey("batch");
  const nestKey = useActionKey("nest");
  const [busy, setBusy] = useState<"validate" | "nest" | null>(null);
  const [failure, setFailure] = useState<ServiceResult<unknown> | null>(null);

  const setMargin = (side: keyof Settings["margins"]) => (value: number | null) =>
    updateSheet({ margins: { ...sheet.margins, [side]: value } });
  const choosePreset = (preset: SheetPreset) =>
    updateSheet(
      preset === "custom"
        ? { preset }
        : { preset, width: SHEET_PRESETS[preset].width, height: SHEET_PRESETS[preset].height },
    );

  const usable = usableArea(sheet);
  const masterOf = (line: BatchLine): Master | undefined => masters[line.masterId];
  const lineIssues = lines.flatMap((line) =>
    lineProblems(line, masterOf(line)?.aspect_ratio ?? null).map((problem) => `${line.productName}: ${problem}`),
  );
  const fitIssues = usable
    ? lines.flatMap((line) => {
        const master = masterOf(line);
        const size = master && actualSize(master.aspect_ratio, line);
        return size && !fitsSheet(size, line.rotations, usable)
          ? [
              `${line.productName}: ${formatMm(size.width)} × ${formatMm(size.height)} mm does not fit the usable ${formatMm(usable.width)} × ${formatMm(usable.height)} mm area in any allowed rotation.`,
            ]
          : [];
      })
    : [];
  const problems = [...(lines.length ? [] : ["Add at least one batch line."]), ...lineIssues, ...sheetProblems(sheet)];

  const groups = new Map<string, { label: string; lines: number; parts: number }>();
  for (const line of lines) {
    if (!line.material || !line.thickness) continue;
    const key = `${line.material}|${line.thickness}`;
    const group = groups.get(key) ?? { label: `${line.material} · ${line.thickness} mm`, lines: 0, parts: 0 };
    group.lines += 1;
    group.parts += line.quantity ?? 0;
    groups.set(key, group);
  }

  async function validate() {
    const request = batchRequest(lines, sheet);
    setBusy("validate");
    setFailure(null);
    const result = await attempt(() =>
      createBatch({ data: { request, idempotencyKey: validateKey.key(JSON.stringify(request)) } }),
    );
    validateKey.settle(result);
    setBusy(null);
    if (result.ok) setDraft(result.data);
    else setFailure(result);
  }

  async function nest(batchId: string) {
    setBusy("nest");
    setFailure(null);
    const result = await attempt(() =>
      startNesting({ data: { batchId, idempotencyKey: nestKey.key(batchId) } }),
    );
    nestKey.settle(result);
    setBusy(null);
    // Only the service's acceptance (a job ID) counts as queued.
    if (result.ok) onStarted({ jobId: result.data.job_id, batchId });
    else setFailure(result);
  }

  return (
    <div className="flex min-h-0 flex-1">
      {[...new Set(lines.map((line) => line.masterId))].map((id) => (
        <MasterLoader key={id} masterId={id} />
      ))}
      <div className="w-96 shrink-0 overflow-y-auto border-r">
        <Section title="Stock sheet">
          <SelectField<SheetPreset>
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
              label="W"
              value={sheet.width}
              disabled={sheet.preset !== "custom"}
              onChange={(width) => width != null && updateSheet({ width })}
            />
            <Mm
              label="H"
              value={sheet.height}
              disabled={sheet.preset !== "custom"}
              onChange={(height) => height != null && updateSheet({ height })}
            />
          </div>
        </Section>
        <Section title="Margins and gap">
          <p className="text-xs text-muted-foreground">
            No workshop values are confirmed yet, so nothing is pre-filled. Enter the margins and the
            minimum part-to-part gap for this job.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Mm label="Left" value={sheet.margins.left} onChange={setMargin("left")} />
            <Mm label="Right" value={sheet.margins.right} onChange={setMargin("right")} />
            <Mm label="Bottom" value={sheet.margins.bottom} onChange={setMargin("bottom")} />
            <Mm label="Top" value={sheet.margins.top} onChange={setMargin("top")} />
          </div>
          <Mm label="Gap" value={sheet.gap} onChange={(gap) => updateSheet({ gap })} />
          {usable && (
            <p className="text-xs text-muted-foreground tabular-nums">
              Usable area {formatMm(usable.width)} × {formatMm(usable.height)} mm
            </p>
          )}
        </Section>
        <Section title="Optimization">
          <NumberField
            label="Max sheets"
            value={sheet.maxSheets}
            min={1}
            step={1}
            format={{ maximumFractionDigits: 0, useGrouping: false }}
            onValueChange={(maxSheets) => updateSheet({ maxSheets: maxSheets != null && Number.isFinite(maxSheets) ? maxSheets : null })}
          />
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
          <NumberField
            label="Seed"
            value={sheet.seed}
            min={0}
            step={1}
            format={{ maximumFractionDigits: 0, useGrouping: false }}
            onValueChange={(seed) => seed != null && Number.isInteger(seed) && seed >= 0 && updateSheet({ seed })}
          />
          <Labelled label="Batch name (optional)">
            <Input
              value={sheet.name}
              maxLength={120}
              onChange={(event) => updateSheet({ name: event.target.value })}
            />
          </Labelled>
        </Section>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Material groups</h3>
          {groups.size ? (
            <ul className="flex flex-wrap gap-2 text-sm">
              {[...groups.values()].map((group) => (
                <li key={group.label} className="rounded-lg border px-3 py-2">
                  <div className="font-medium">{group.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {group.lines} line{group.lines === 1 ? "" : "s"} · {group.parts} parts · nested on separate sheets
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Groups appear once lines have a material and thickness.</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            The sheet count is only known after nesting completes.
          </p>
        </div>

        {(problems.length > 0 || fitIssues.length > 0) && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Before validating</h3>
            <ul className="list-disc pl-5 text-xs">
              {problems.map((problem) => (
                <li key={problem} className="text-muted-foreground">{problem}</li>
              ))}
              {fitIssues.map((issue) => (
                <li key={issue} className="text-destructive">{issue}</li>
              ))}
            </ul>
          </div>
        )}

        <ResultAlert result={failure} title="The service did not accept the request" />

        <div className="flex items-center gap-2">
          <Button
            variant={draft ? "outline" : "default"}
            disabled={!canEdit || problems.length > 0 || busy != null}
            onClick={() => void validate()}
          >
            {busy === "validate" ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Validate batch
          </Button>
          {draft && (
            <Button
              disabled={!canEdit || draft.status !== "draft" || busy != null}
              onClick={() => void nest(draft.batch_id)}
            >
              {busy === "nest" ? <Loader2 className="animate-spin" /> : <Play />} Start nesting
            </Button>
          )}
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
                    <p className="text-xs font-medium">{name}</p>
                    {line.errors.map((error, index) => (
                      <ErrorText key={index} error={error} />
                    ))}
                  </div>
                );
              })}
            {draft.status === "invalid" && (
              <p className="text-xs text-destructive">Fix the lines above and validate again.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
