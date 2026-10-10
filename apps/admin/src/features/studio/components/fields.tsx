import type { ReactNode } from "react";
import { NumberField } from "@workspace/ui/components/number-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Switch } from "@workspace/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-b px-3 py-3 last:border-b-0">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-2", className)}>{children}</div>;
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function Num({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  digits = 2,
  disabled,
  live = true,
}: {
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: ReactNode;
  digits?: number;
  disabled?: boolean;
  /** Apply while typing/scrubbing; false applies on Enter, blur or scrub end. */
  live?: boolean;
}) {
  const apply = (next: number | null) => {
    if (next != null && Number.isFinite(next)) onChange(next);
  };
  return (
    <NumberField
      label={label}
      unit={unit}
      value={Number(value.toFixed(digits))}
      min={min}
      max={max}
      step={step}
      smallStep={step / 10}
      largeStep={step * 10}
      format={{ maximumFractionDigits: digits, useGrouping: false }}
      disabled={disabled}
      onValueChange={live ? apply : undefined}
      onValueCommitted={live ? undefined : apply}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      spacing={0}
      value={[value]}
      onValueChange={(values) => {
        const next = values[0] as T | undefined;
        if (next) onChange(next);
      }}
      className={cn("w-full", className)}
    >
      {options.map((option) =>
        option.title ? (
          <Tooltip key={option.value}>
            <TooltipTrigger
              render={
                <ToggleGroupItem value={option.value} className="flex-1" aria-label={option.title} />
              }
            >
              {option.label}
            </TooltipTrigger>
            <TooltipContent>{option.title}</TooltipContent>
          </Tooltip>
        ) : (
          <ToggleGroupItem key={option.value} value={option.value} className="flex-1">
            {option.label}
          </ToggleGroupItem>
        ),
      )}
    </ToggleGroup>
  );
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next != null) onChange(next as T);
      }}
    >
      <SelectTrigger className={cn("w-full", className)} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 text-sm">
      <span className="flex flex-col">
        {label}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

export function ColorField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-input px-1.5">
      <input
        type="color"
        aria-label={label}
        value={HEX.test(value) ? value : "#000000"}
        onChange={(event) => onChange(event.target.value)}
        className="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <input
        key={value}
        defaultValue={value}
        aria-label={`${label} hex`}
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs uppercase outline-none"
        onBlur={(event) => {
          const next = event.target.value.trim();
          const normalized = next.startsWith("#") ? next : `#${next}`;
          if (HEX.test(normalized)) onChange(normalized.toLowerCase());
          else event.target.value = value;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}

const TOLERANCES = ["0.01", "0.02", "0.05", "0.1"];

/** Curve accuracy for DXF polylines (max deviation from the true curve). */
export function ToleranceField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <Labelled label="DXF curve accuracy">
      <SelectField
        value={String(value)}
        options={TOLERANCES.map((tolerance) => ({
          value: tolerance,
          label: `±${tolerance} mm${tolerance === "0.02" ? " (recommended)" : ""}`,
        }))}
        onChange={(next) => onChange(Number(next))}
        aria-label="DXF curve accuracy"
      />
    </Labelled>
  );
}
