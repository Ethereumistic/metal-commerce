import * as React from "react"
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Compact numeric input. Drag the label horizontally to scrub the value,
 * use arrow keys to step (Shift = large step, Alt = small step).
 */
function NumberField({
  className,
  label,
  unit,
  id,
  ...props
}: NumberFieldPrimitive.Root.Props & {
  label?: React.ReactNode
  unit?: React.ReactNode
}) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  return (
    <NumberFieldPrimitive.Root
      data-slot="number-field"
      id={inputId}
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    >
      <NumberFieldPrimitive.Group
        data-slot="number-field-group"
        className="flex h-8 min-w-0 items-center rounded-lg border border-input bg-transparent text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 data-disabled:pointer-events-none data-disabled:opacity-50 dark:bg-input/30"
      >
        {label != null && (
          <NumberFieldPrimitive.ScrubArea
            data-slot="number-field-scrub-area"
            className="flex h-full shrink-0 cursor-ew-resize items-center pl-2 pr-1 text-xs text-muted-foreground select-none"
          >
            <label htmlFor={inputId} className="cursor-ew-resize">
              {label}
            </label>
            <NumberFieldPrimitive.ScrubAreaCursor className="drop-shadow-[0_1px_1px_#0008] filter">
              <svg width="26" height="14" viewBox="0 0 24 14" fill="black" stroke="white" aria-hidden>
                <path d="M19.5 5.5L6.49737 5.51844V2L1 6.9999L6.5 12L6.49737 8.5L19.5 8.5V12L25 6.9999L19.5 2V5.5Z" />
              </svg>
            </NumberFieldPrimitive.ScrubAreaCursor>
          </NumberFieldPrimitive.ScrubArea>
        )}
        <NumberFieldPrimitive.Input
          data-slot="number-field-input"
          className={cn(
            "h-full w-full min-w-0 bg-transparent px-2 tabular-nums outline-none",
            label != null && "pl-1"
          )}
        />
        {unit != null && (
          <span className="shrink-0 pr-2 text-xs text-muted-foreground select-none">
            {unit}
          </span>
        )}
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  )
}

export { NumberField }
