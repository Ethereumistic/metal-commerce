import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { NumberField } from "@workspace/ui/components/number-field";
import { cn } from "@workspace/ui/lib/utils";
import { parseQuantityText } from "./batch-logic";

const clean = (value: number | null) => (value != null && Number.isFinite(value) ? value : null);

/**
 * A number field that keeps what the operator types locally and hands it to
 * the store only on blur, Enter, arrow-key steps or scrub release. Typing
 * then re-renders this field (and whatever listens to `onDraft`) instead of
 * the whole workspace, and the store is not written on every keystroke.
 */
export const DraftNumberField = memo(function DraftNumberField({
  label,
  unit,
  value,
  onCommit,
  onDraft,
  onEnter,
  min = 0,
  step = 1,
  digits = 2,
  disabled,
  className,
}: {
  label: ReactNode;
  unit?: ReactNode;
  value: number | null;
  onCommit: (value: number | null) => void;
  /** The typed value before it is committed (undefined once committed), for live previews. */
  onDraft?: (value: number | null | undefined) => void;
  /** Called after Enter commits, e.g. to move to the next row. */
  onEnter?: (event: KeyboardEvent<HTMLDivElement>) => void;
  min?: number;
  step?: number;
  digits?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<{ value: number | null } | null>(null);
  const typed = useRef<{ value: number | null } | null>(null);
  // The value handed over but not yet back as `value`: Enter followed by a
  // focus move blurs the field before React re-renders, and that blur must
  // not commit the same value twice.
  const sent = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    sent.current = undefined;
  }, [value]);

  const commit = (next: number | null) => {
    typed.current = null;
    setDraft(null);
    onDraft?.(undefined);
    if (next === value || next === sent.current) return;
    sent.current = next;
    onCommit(next);
  };

  return (
    <div
      className="min-w-0"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (typed.current) commit(typed.current.value);
        onEnter?.(event);
      }}
    >
      <NumberField
        label={label}
        unit={unit}
        value={draft ? draft.value : value}
        min={min}
        step={step}
        smallStep={step / 10}
        largeStep={step * 10}
        format={{ maximumFractionDigits: digits, useGrouping: false }}
        disabled={disabled}
        className={className}
        onValueChange={(next) => {
          const entry = { value: clean(next) };
          typed.current = entry;
          setDraft(entry);
          onDraft?.(entry.value);
        }}
        onValueCommitted={(next) => commit(clean(next))}
      />
    </div>
  );
});

/**
 * A quantity typed as text and never corrected: "0" stays 0 and "-5" stays
 * -5 so the row can say what is wrong, instead of silently becoming 1 or 5.
 * The value reaches the store on blur, Enter or an arrow-key step, like the
 * number fields; non-numeric text is kept on screen and stored as "no
 * quantity".
 */
export const QuantityField = memo(function QuantityField({
  label = "Qty",
  value,
  invalid,
  describedBy,
  onCommit,
  onDraft,
  onEnter,
  className,
}: {
  label?: ReactNode;
  value: number | null;
  /** Shows the field as needing correction. */
  invalid?: boolean;
  /** Id of the element that explains the problem. */
  describedBy?: string;
  onCommit: (value: number | null) => void;
  onDraft?: (value: number | null | undefined) => void;
  onEnter?: () => void;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState(() => (value == null ? "" : String(value)));
  // Follow the store when it changes elsewhere (bulk apply, duplicate), but
  // keep unparseable text the operator typed while it still means "no value".
  useEffect(() => {
    setText((current) => {
      const typed = parseQuantityText(current);
      if (typed === value) return current;
      // "abc" committed as no quantity: keep showing what was typed.
      if (value == null && typed == null) return current;
      return value == null ? "" : String(value);
    });
  }, [value]);

  const commit = (raw: string) => {
    const next = parseQuantityText(raw);
    onDraft?.(undefined);
    if (next !== value) onCommit(next);
  };
  const step = (delta: number) => {
    const current = parseQuantityText(text);
    const next = Number.isInteger(current) ? current! + delta : Math.max(1, delta);
    setText(String(next));
    onCommit(next);
  };

  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center rounded-lg border border-input text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        invalid && "border-ws-hazard bg-ws-hazard/10 focus-within:border-ws-hazard focus-within:ring-ws-hazard/40",
        className,
      )}
    >
      <label htmlFor={id} className="shrink-0 pr-1 pl-2 text-xs text-muted-foreground select-none">
        {label}
      </label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onDraft?.(parseQuantityText(event.target.value));
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            step((event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
            onEnter?.();
          }
        }}
        className="h-full w-full min-w-0 bg-transparent pr-2 pl-1 tabular-nums outline-none"
      />
    </div>
  );
});
