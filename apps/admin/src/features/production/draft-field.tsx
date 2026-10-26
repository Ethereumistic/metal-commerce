import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { NumberField } from "@workspace/ui/components/number-field";

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
