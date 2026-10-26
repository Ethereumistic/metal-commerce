import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Copy, Loader2, Trash2 } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { NumberField } from "@workspace/ui/components/number-field";
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@workspace/ui/lib/utils";
import { Segmented, SelectField } from "../studio/components/fields";
import { ALL_ROTATIONS, isEmptyPatch, quantityProblem, type BulkPatch } from "./batch-logic";
import type { Rotation, SizeMode } from "./contracts";
import { DraftNumberField, QuantityField } from "./draft-field";
import { consumeRequestedFocus, focusField } from "./focus";
import { ProductImage } from "./product-image";
import { Checkbox } from "./checkbox";
import { actualSize } from "./sizing";
import { plural } from "./results-logic";
import { ErrorText, PreparationBadge, formatMm } from "./status";
import { MATERIALS, useProduction, type BatchLine } from "./store";
import { useMaster } from "./trace-preview";
import { batchIssues, invalidLineCount, lineIssues, type LineField } from "./validation";

type Drafts = Partial<Pick<BatchLine, "width" | "height" | "quantity" | "thickness">>;

const materialOptions = (current: string) => [
  ...(current ? [] : [{ value: "none", label: "Material…" }]),
  ...MATERIALS.map((material) => ({ value: material, label: material })),
];

function Rotations({
  value,
  onChange,
  label,
}: {
  value: Rotation[];
  onChange: (rotations: Rotation[]) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      multiple
      variant="outline"
      size="sm"
      spacing={0}
      aria-label={label}
      value={value.map(String)}
      onValueChange={(values) =>
        onChange(ALL_ROTATIONS.filter((rotation) => values.includes(String(rotation))))
      }
    >
      {ALL_ROTATIONS.map((rotation) => (
        <ToggleGroupItem key={rotation} value={String(rotation)} aria-label={`Allow ${rotation}°`}>
          {rotation}°
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

type RowProps = {
  lineId: string;
  chosen: boolean;
  onChoose: (lineId: string, chosen: boolean) => void;
  onEnter: (lineId: string, field: LineField) => void;
};

/**
 * One batch line. It subscribes to its own line only, so editing a row
 * re-renders that row and nothing else; typed values stay local until the
 * field is left or Enter is pressed.
 */
const LineRow = memo(function LineRow({ lineId, chosen, onChoose, onEnter }: RowProps) {
  const line = useProduction((state) => state.lines.find((entry) => entry.lineId === lineId));
  const service = useProduction((state) => state.draft?.lines.find((entry) => entry.line_id === lineId));
  const { master, failure } = useMaster(line?.masterId ?? null);
  const [drafts, setDrafts] = useState<Drafts>({});
  if (!line) return null;

  const { updateLine, duplicateLine, removeLine } = useProduction.getState();
  const update = (patch: Partial<BatchLine>) => updateLine(lineId, patch);
  const draftOf = (field: keyof Drafts) => (value: number | null | undefined) =>
    setDrafts((current) => {
      const next = { ...current };
      if (value === undefined) delete next[field];
      else next[field] = value;
      return next;
    });
  const effective = { ...line, ...drafts };
  const actual = master ? actualSize(master.aspect_ratio, effective) : null;
  const problems = lineIssues(effective, master?.aspect_ratio ?? null);
  const cell = (field: LineField) => ({ "data-line": lineId, "data-field": field });

  const problemId = `problems-${lineId}`;
  const quantityInvalid = problems.some((entry) => entry.field === "quantity");

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 grow basis-60 items-center gap-2">
          <Checkbox label={`Select ${line.productName}`} checked={chosen} onChange={(next) => onChoose(lineId, next)} />
          <ProductImage thumbnail={line.thumbnail} masterId={line.masterId} name={line.productName} className="size-10" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium" title={line.productName}>
              {line.productName}
            </span>
            <span className="truncate text-xs text-muted-foreground tabular-nums">
              {actual ? (
                <>
                  Cuts at <span className="text-foreground">{formatMm(actual.width)} × {formatMm(actual.height)} mm</span>
                </>
              ) : master ? (
                "Enter a size"
              ) : (
                "Loading master…"
              )}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div {...cell("width")} className="w-[6.5rem]">
            <DraftNumberField
              label="W"
              unit="mm"
              value={line.mode === "height" ? null : line.width}
              disabled={line.mode === "height"}
              onDraft={draftOf("width")}
              onCommit={(width) => update({ width })}
              onEnter={() => onEnter(lineId, "width")}
            />
          </div>
          <div {...cell("height")} className="w-[6.5rem]">
            <DraftNumberField
              label="H"
              unit="mm"
              value={line.mode === "width" ? null : line.height}
              disabled={line.mode === "width"}
              onDraft={draftOf("height")}
              onCommit={(height) => update({ height })}
              onEnter={() => onEnter(lineId, "height")}
            />
          </div>
          <div {...cell("quantity")} className="w-24">
            <QuantityField
              value={line.quantity}
              invalid={quantityInvalid}
              describedBy={problems.length ? problemId : undefined}
              onDraft={draftOf("quantity")}
              onCommit={(quantity) => update({ quantity })}
              onEnter={() => onEnter(lineId, "quantity")}
            />
          </div>
          <div {...cell("material")} className="w-[8rem]">
            <SelectField
              value={line.material || "none"}
              options={materialOptions(line.material)}
              onChange={(material) => update({ material: material === "none" ? "" : material })}
              aria-label={`Material of ${line.productName}`}
            />
          </div>
          <div {...cell("thickness")} className="w-[5.5rem]">
            <DraftNumberField
              label="t"
              unit="mm"
              value={line.thickness}
              onDraft={draftOf("thickness")}
              onCommit={(thickness) => update({ thickness })}
              onEnter={() => onEnter(lineId, "thickness")}
            />
          </div>
        </div>
      </div>

      {/* Less frequent controls come after the main fields in tab order. */}
      <div className="flex flex-wrap items-center gap-2 pl-[4.5rem]">
        <Segmented<SizeMode>
          className="w-auto"
          value={line.mode}
          options={[
            { value: "width", label: "Width", title: "Set the width; height follows the master's aspect ratio" },
            { value: "height", label: "Height", title: "Set the height; width follows the master's aspect ratio" },
            { value: "fit", label: "Fit", title: "Largest size that fits inside width × height, aspect ratio kept" },
          ]}
          onChange={(mode) => update({ mode })}
        />
        <div className="flex items-center gap-1.5" {...cell("rotations")}>
          <span className="text-xs text-muted-foreground">Rotations</span>
          <Rotations label={`Rotations of ${line.productName}`} value={line.rotations} onChange={(rotations) => update({ rotations })} />
        </div>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Duplicate ${line.productName} for another size`}
          title="Duplicate for another size"
          onClick={() => duplicateLine(lineId)}
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${line.productName}`}
          title="Remove line"
          onClick={() => removeLine(lineId)}
        >
          <Trash2 />
        </Button>
      </div>

      {problems.length > 0 && (
        <p id={problemId} className="flex items-start gap-1.5 pl-[4.5rem] text-xs text-ws-hazard-ink">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{problems.map((entry) => entry.message).join(" ")}</span>
        </p>
      )}
      {failure && !failure.ok && (
        <p className="pl-[4.5rem] text-xs text-destructive">
          {failure.offline ? "Local processing service offline; the master cannot be loaded." : failure.error.message}
        </p>
      )}
      {service && (
        <div className="flex flex-col gap-0.5 pl-[4.5rem]">
          <p className="text-xs tabular-nums">
            Checked by the service:{" "}
            {service.actual_width_mm != null && service.actual_height_mm != null
              ? `${formatMm(service.actual_width_mm)} × ${formatMm(service.actual_height_mm)} mm, `
              : "size unavailable, "}
            {service.fits ? (
              <span className="text-ws-cut">fits the sheet</span>
            ) : (
              <span className="text-destructive">does not fit the sheet</span>
            )}
          </p>
          {service.errors.map((error, index) => (
            <ErrorText key={index} error={error} />
          ))}
        </div>
      )}
    </li>
  );
});

/** Shared values for many rows at once: only the fields filled in here are applied. */
function BulkBar({ chosen, total }: { chosen: ReadonlySet<string>; total: number }) {
  const [width, setWidth] = useState<number | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [material, setMaterial] = useState("");
  const [thickness, setThickness] = useState<number | null>(null);
  const [rotations, setRotations] = useState<Rotation[]>([]);
  const patch: BulkPatch = {
    ...(width != null && width > 0 ? { width } : {}),
    ...(quantity != null && !quantityProblem(quantity) ? { quantity } : {}),
    ...(material ? { material } : {}),
    ...(thickness != null && thickness > 0 ? { thickness } : {}),
    ...(rotations.length ? { rotations } : {}),
  };
  const quantityNote = quantity != null ? quantityProblem(quantity) : null;
  const target = chosen.size ? chosen : null;
  const apply = () => {
    if (!isEmptyPatch(patch)) useProduction.getState().applyToLines(target, patch);
  };
  const num = (value: number | null) => (value != null && Number.isFinite(value) ? value : null);

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2"
      onKeyDown={(event) => {
        // Number fields report each typed value, so Enter can apply right away.
        if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") apply();
      }}
    >
      <span className="text-xs font-semibold text-muted-foreground">Set for {target ? `${chosen.size} selected` : "all rows"}</span>
      <NumberField
        className="w-28"
        label="W"
        unit="mm"
        value={width}
        min={0}
        format={{ maximumFractionDigits: 2, useGrouping: false }}
        onValueChange={(value) => setWidth(num(value))}
      />
      <QuantityField className="w-24" value={quantity} invalid={quantityNote != null} onCommit={setQuantity} onDraft={(value) => value !== undefined && setQuantity(value)} />
      <SelectField
        className="w-32"
        value={material || "none"}
        options={[{ value: "none", label: "Material…" }, ...MATERIALS.map((entry) => ({ value: entry, label: entry }))]}
        onChange={(value) => setMaterial(value === "none" ? "" : value)}
        aria-label="Material for the rows"
      />
      <NumberField
        className="w-24"
        label="t"
        unit="mm"
        value={thickness}
        min={0}
        format={{ maximumFractionDigits: 2, useGrouping: false }}
        onValueChange={(value) => setThickness(num(value))}
      />
      <Rotations label="Rotations for the rows" value={rotations} onChange={setRotations} />
      <Button size="sm" variant="secondary" disabled={isEmptyPatch(patch)} onClick={apply}>
        Apply to {target ? `${chosen.size} selected` : `all ${total}`}
      </Button>
      {quantityNote && <span className="basis-full text-xs text-ws-hazard-ink">{quantityNote}</span>}
    </div>
  );
}

/** Selected products that join the batch once their master is ready. */
function PendingRows() {
  const pending = useProduction(useShallow((state) => Object.values(state.pendingAdds)));
  const preparation = useProduction((state) => state.preparation);
  const drop = useProduction((state) => state.dropPendingAdd);
  if (!pending.length) return null;
  return (
    <>
      {pending.map((product) => {
        const item = preparation[product.productId];
        const failed = item?.status === "failed" || item?.status === "stale";
        return (
          <li key={product.productId} className="flex items-center gap-2 bg-muted/20 px-3 py-2">
            <span className="w-4" />
            <ProductImage thumbnail={product.thumbnail} name={product.name} className="size-10" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{product.name}</span>
              {failed && item?.error ? (
                <ErrorText error={item.error} />
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {!failed && <Loader2 className="size-3 animate-spin" />}
                  {failed
                    ? "Preparation did not finish. Prepare it again on the Products step, or remove it."
                    : "Preparing; the row is added here when the master is ready."}
                </span>
              )}
            </div>
            <PreparationBadge status={item?.status ?? null} />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Do not add ${product.name}`}
              title="Do not add"
              onClick={() => drop(product.productId)}
            >
              <Trash2 />
            </Button>
          </li>
        );
      })}
    </>
  );
}

export function BatchEditor() {
  const ids = useProduction(useShallow((state) => state.lines.map((line) => line.lineId)));
  const pendingCount = useProduction((state) => Object.keys(state.pendingAdds).length);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const order = useRef(ids);
  order.current = ids;

  useEffect(() => {
    consumeRequestedFocus();
  }, []);

  // Forget selections of removed rows.
  const live = new Set(ids);
  const chosenLive = [...chosen].every((id) => live.has(id)) ? chosen : new Set([...chosen].filter((id) => live.has(id)));

  const onChoose = useCallback(
    (lineId: string, next: boolean) =>
      setChosen((current) => {
        const copy = new Set(current);
        if (next) copy.add(lineId);
        else copy.delete(lineId);
        return copy;
      }),
    [],
  );
  // Enter moves to the same field of the next row, like a spreadsheet.
  const onEnter = useCallback((lineId: string, field: LineField) => {
    const index = order.current.indexOf(lineId);
    const next = order.current[index + 1];
    if (next) focusField({ scope: "line", lineId: next, field });
  }, []);

  if (!ids.length && !pendingCount)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        No rows yet. Select products on the Products step, then add them to a batch.
      </div>
    );
  const allChosen = ids.length > 0 && chosenLive.size === ids.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {ids.length > 0 && (
        <>
          <BulkBar chosen={chosenLive} total={ids.length} />
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <Checkbox
              label="Select all rows"
              checked={allChosen}
              indeterminate={chosenLive.size > 0 && !allChosen}
              onChange={(next) => setChosen(next ? new Set(ids) : new Set())}
            />
            <span>
              {chosenLive.size ? `${chosenLive.size} of ${plural(ids.length, "row")} selected` : plural(ids.length, "row")}. Enter moves to
              the same field in the next row.
            </span>
          </div>
        </>
      )}
      <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
        {ids.map((lineId) => (
          <LineRow key={lineId} lineId={lineId} chosen={chosenLive.has(lineId)} onChoose={onChoose} onEnter={onEnter} />
        ))}
        <PendingRows />
      </ul>
    </div>
  );
}

/** Continue to Sheets, only once every row is complete; otherwise jump to the first problem. */
export function BatchFooter({ onContinue }: { onContinue: () => void }) {
  const lineCount = useProduction((state) => state.lines.length);
  const parts = useProduction((state) =>
    state.lines.reduce((sum, line) => sum + (line.quantity != null && Number.isInteger(line.quantity) && line.quantity > 0 ? line.quantity : 0), 0),
  );
  const invalid = useProduction((state) => invalidLineCount(state.lines, state.masters));
  const pending = useProduction((state) => Object.keys(state.pendingAdds).length);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setMessage(null), [invalid, pending]);

  if (!lineCount && !pending) return null;

  const proceed = () => {
    const { lines, masters } = useProduction.getState();
    const issues = batchIssues(lines, masters);
    const first = issues[0];
    if (first) {
      const rows = new Set(issues.map((entry) => entry.lineId)).size;
      setMessage(`${plural(rows, "row")} need${rows === 1 ? "s" : ""} attention. ${first.productName}: ${first.issue.message}`);
      if (first.issue.field) focusField({ scope: "line", lineId: first.lineId, field: first.issue.field });
      return;
    }
    if (pending) {
      setMessage(
        `${plural(pending, "product")} still being prepared. Wait until ${pending === 1 ? "it joins" : "they join"} the batch, or remove ${pending === 1 ? "it" : "them"}.`,
      );
      return;
    }
    setMessage(null);
    onContinue();
  };

  const status =
    message ??
    (invalid
      ? `${plural(invalid, "row")} need${invalid === 1 ? "s" : ""} attention before nesting.`
      : pending
        ? `${plural(pending, "product")} still preparing.`
        : `Ready: ${plural(lineCount, "row")}, ${plural(parts, "part")}.`);
  return (
    <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t bg-ws-panel px-3 py-2">
      <span
        className={cn("min-w-0 flex-1 truncate text-xs", invalid || message ? "text-ws-hazard-ink" : "text-muted-foreground")}
        role="status"
        title={status}
      >
        {status}
      </span>
      <Button onClick={proceed}>
        Continue to sheets <ArrowRight />
      </Button>
    </div>
  );
}
