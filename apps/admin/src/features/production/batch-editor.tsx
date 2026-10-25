import { Copy, Trash2 } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { NumberField } from "@workspace/ui/components/number-field";
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group";
import { Segmented, SelectField } from "../studio/components/fields";
import { ROTATIONS, type BatchDraft, type Rotation, type SizeMode } from "./contracts";
import { actualSize } from "./sizing";
import { ErrorText, formatMm } from "./status";
import { MATERIALS, THICKNESS_CEILINGS_MM, useProduction, type BatchLine } from "./store";
import { useMaster } from "./trace-preview";

/** Problems the operator must fix before the service is asked to validate the batch. */
export function lineProblems(line: BatchLine, aspectRatio: number | null): string[] {
  const problems: string[] = [];
  if (aspectRatio == null) problems.push("Master not loaded yet.");
  else if (!actualSize(aspectRatio, line)) problems.push("Enter the size.");
  if (!line.quantity || !Number.isInteger(line.quantity) || line.quantity < 1)
    problems.push("Quantity must be a whole number of at least 1.");
  if (!line.material) problems.push("Choose a material.");
  if (!line.thickness || line.thickness <= 0) problems.push("Enter the sheet thickness.");
  else if (line.material && line.thickness > (THICKNESS_CEILINGS_MM[line.material] ?? Infinity))
    problems.push(
      `${line.thickness} mm exceeds the current machine's ${THICKNESS_CEILINGS_MM[line.material]} mm ${line.material.toLowerCase()} ceiling.`,
    );
  if (!line.rotations.length) problems.push("Allow at least one rotation.");
  return problems;
}

function MmField({
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
      format={{ maximumFractionDigits: 2, useGrouping: false }}
      disabled={disabled}
      onValueChange={(next) => onChange(next != null && Number.isFinite(next) ? next : null)}
    />
  );
}

function LineRow({ line, draft }: { line: BatchLine; draft: BatchDraft["lines"][number] | undefined }) {
  const { updateLine, duplicateLine, removeLine } = useProduction.getState();
  const { master, failure } = useMaster(line.masterId);
  const update = (patch: Partial<BatchLine>) => updateLine(line.lineId, patch);
  const actual = master ? actualSize(master.aspect_ratio, line) : null;
  const problems = lineProblems(line, master?.aspect_ratio ?? null);

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{line.productName}</span>
        {master && (
          <span className="text-xs text-muted-foreground tabular-nums">
            master r{master.revision} · aspect {master.aspect_ratio.toFixed(3)}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Duplicate this line for another size"
          title="Duplicate for another size"
          onClick={() => duplicateLine(line.lineId)}
        >
          <Copy />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Remove line" onClick={() => removeLine(line.lineId)}>
          <Trash2 />
        </Button>
      </div>
      <div className="grid grid-cols-[minmax(12rem,auto)_repeat(3,minmax(7rem,1fr))] items-center gap-2">
        <Segmented<SizeMode>
          value={line.mode}
          options={[
            { value: "width", label: "Width", title: "Set the width; height follows the master's aspect ratio" },
            { value: "height", label: "Height", title: "Set the height; width follows the master's aspect ratio" },
            { value: "fit", label: "Fit", title: "Largest size that fits inside width × height, aspect ratio kept" },
          ]}
          onChange={(mode) => update({ mode })}
        />
        <MmField
          label="W"
          value={line.mode === "height" ? null : line.width}
          disabled={line.mode === "height"}
          onChange={(width) => update({ width })}
        />
        <MmField
          label="H"
          value={line.mode === "width" ? null : line.height}
          disabled={line.mode === "width"}
          onChange={(height) => update({ height })}
        />
        <div className="text-xs tabular-nums">
          <span className="text-muted-foreground">Actual </span>
          {actual ? `${formatMm(actual.width)} × ${formatMm(actual.height)} mm` : "—"}
        </div>
      </div>
      <div className="grid grid-cols-[7rem_10rem_8rem_1fr] items-center gap-2">
        <NumberField
          label="Qty"
          value={line.quantity}
          min={1}
          step={1}
          format={{ maximumFractionDigits: 0, useGrouping: false }}
          onValueChange={(quantity) => update({ quantity: quantity != null && Number.isFinite(quantity) ? quantity : null })}
        />
        <SelectField
          value={line.material || "none"}
          options={[
            ...(line.material ? [] : [{ value: "none", label: "Material…" }]),
            ...MATERIALS.map((material) => ({ value: material, label: material })),
          ]}
          onChange={(material) => update({ material: material === "none" ? "" : material })}
          aria-label="Material"
        />
        <MmField label="t" value={line.thickness} onChange={(thickness) => update({ thickness })} />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Rotations</span>
          <ToggleGroup
            multiple
            variant="outline"
            size="sm"
            spacing={0}
            value={line.rotations.map(String)}
            onValueChange={(values) =>
              update({
                rotations: ROTATIONS.filter((rotation) => values.includes(String(rotation))) as Rotation[],
              })
            }
          >
            {ROTATIONS.map((rotation) => (
              <ToggleGroupItem key={rotation} value={String(rotation)} aria-label={`Allow ${rotation}°`}>
                {rotation}°
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
      {failure && !failure.ok && (
        <p className="text-xs text-destructive">
          {failure.offline ? "Local processing service offline; the master cannot be loaded." : failure.error.message}
        </p>
      )}
      {problems.length > 0 && <p className="text-xs text-muted-foreground">{problems.join(" ")}</p>}
      {draft && (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs tabular-nums">
            Service: {formatMm(draft.actual_width_mm)} × {formatMm(draft.actual_height_mm)} mm ·{" "}
            {draft.fits ? (
              <span className="text-emerald-600 dark:text-emerald-400">fits the sheet</span>
            ) : (
              <span className="text-destructive">does not fit</span>
            )}
          </p>
          {draft.errors.map((error, index) => (
            <ErrorText key={index} error={error} />
          ))}
        </div>
      )}
    </li>
  );
}

export function BatchEditor() {
  const lines = useProduction((state) => state.lines);
  const draft = useProduction((state) => state.draft);
  if (!lines.length)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        No lines yet. Prepare products, then add the ready ones to the batch.
      </div>
    );
  return (
    <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
      {lines.map((line) => (
        <LineRow
          key={line.lineId}
          line={line}
          draft={draft?.lines.find((entry) => entry.line_id === line.lineId)}
        />
      ))}
    </ul>
  );
}
