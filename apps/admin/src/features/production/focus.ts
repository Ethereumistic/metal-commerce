// Moving keyboard focus between Production fields. Inputs are found by data
// attributes on their wrappers, so rows and settings need no ref plumbing.

export type FocusTarget = { scope: "line"; lineId: string; field: string } | { scope: "sheet"; field: string };

function selector(target: FocusTarget) {
  return target.scope === "line"
    ? `[data-line="${CSS.escape(target.lineId)}"][data-field="${CSS.escape(target.field)}"]`
    : `[data-sheet-field="${CSS.escape(target.field)}"]`;
}

/** Focuses the field's input (or its first focusable control); false when it is not on screen. */
export function focusField(target: FocusTarget): boolean {
  const wrapper = document.querySelector(selector(target));
  const control = wrapper?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])");
  if (!control) return false;
  control.focus();
  control.scrollIntoView({ block: "nearest" });
  if (control instanceof HTMLInputElement) control.select();
  return true;
}

let requested: FocusTarget | null = null;

/** Asks the next stage to mount to focus a field (e.g. a row fixed from the Sheets step). */
export function requestFocus(target: FocusTarget) {
  requested = target;
}

/** Focuses a field requested before the current stage mounted. */
export function consumeRequestedFocus() {
  const target = requested;
  requested = null;
  if (target) focusField(target);
}
