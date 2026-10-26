import type { PreparationItem, Rotation } from "./contracts";
import type {
  BatchLine,
  SelectedProduct,
  LineDefaults,
  Margins,
  PendingAdd,
  ProductInfo,
  SheetMemory,
  SheetPreset,
  SheetSettings,
} from "./store";

// Pure rules behind the Production workspace's data entry: which lines get
// added, how a shared value is applied to many rows, what the operator's
// sheet settings are per preset, and how older saved state is upgraded.
// No runtime imports, so node's test runner can load this file directly.

/** Machine capacities from docs/laser-machine-specs.md (owner-reported, 10 October 2026). */
export const SHEET_PRESETS = {
  current: { label: "Current machine · 1500 × 3000 mm", width: 1500, height: 3000 },
  future: {
    label: "Future capacity (not yet installed) · 2000 × 4000 mm",
    width: 2000,
    height: 4000,
  },
} as const;

/** Materials with owner-reported capacity on the current machine (generic grades only). */
export const MATERIALS = ["Steel", "Aluminium"] as const;

/** Owner-reported thickness ceilings of the current machine; capacity limits, not recommendations. */
export const THICKNESS_CEILINGS_MM: Record<string, number> = { Steel: 12, Aluminium: 4 };

/**
 * A fresh sheet. Margins and gap are workshop settings nobody has confirmed
 * yet, so they start blank for the operator to enter.
 */
export const DEFAULT_SHEET: SheetSettings = {
  preset: "current",
  width: SHEET_PRESETS.current.width,
  height: SHEET_PRESETS.current.height,
  margins: { left: null, right: null, bottom: null, top: null },
  linkMargins: true,
  gap: null,
  maxSheets: 10,
  timeBudget: 30,
  seed: 1,
  name: "",
};

export const ALL_ROTATIONS: Rotation[] = [0, 90, 180, 270];

export type NewLine = Omit<BatchLine, "lineId">;

/** A fresh row: size and quantity blank, material/thickness only from the operator's own last entry. */
export function newLine(
  product: { id: string; name: string; thumbnail: string | null },
  masterId: string,
  defaults: LineDefaults,
): NewLine {
  return {
    productId: product.id,
    productName: product.name,
    thumbnail: product.thumbnail,
    masterId,
    mode: "width",
    width: null,
    height: null,
    quantity: null,
    material: defaults.material,
    thickness: defaults.thickness,
    rotations: [...ALL_ROTATIONS],
  };
}

/**
 * The candidates that are not in the batch yet. A product already on a line
 * (at any size) is not added again; another size of it is made with
 * Duplicate. Repeated candidates for one product collapse to the first.
 */
export function withoutDuplicates(existing: readonly BatchLine[], candidates: readonly NewLine[]): NewLine[] {
  const present = new Set(existing.map((line) => line.productId));
  const result: NewLine[] = [];
  for (const candidate of candidates) {
    if (present.has(candidate.productId)) continue;
    present.add(candidate.productId);
    result.push(candidate);
  }
  return result;
}

/** Values from the shared entry bar; only the ones the operator filled in are applied. */
export type BulkPatch = {
  width?: number;
  quantity?: number;
  material?: string;
  thickness?: number;
  rotations?: Rotation[];
};

export function isEmptyPatch(patch: BulkPatch) {
  return Object.values(patch).every((value) => value === undefined);
}

/**
 * Applies the bar's values to the chosen rows (all rows when `ids` is null).
 * A width switches height-driven rows to width-driven, since a width is what
 * the operator asked for. Untouched rows keep their identity so memoized
 * rows do not re-render.
 */
export function applyToLines(
  lines: readonly BatchLine[],
  ids: ReadonlySet<string> | null,
  patch: BulkPatch,
): BatchLine[] {
  if (isEmptyPatch(patch)) return [...lines];
  return lines.map((line) => {
    if (ids && !ids.has(line.lineId)) return line;
    const next: BatchLine = { ...line };
    if (patch.width !== undefined) {
      next.width = patch.width;
      if (next.mode === "height") next.mode = "width";
    }
    if (patch.quantity !== undefined) next.quantity = patch.quantity;
    if (patch.material !== undefined) next.material = patch.material;
    if (patch.thickness !== undefined) next.thickness = patch.thickness;
    if (patch.rotations !== undefined) next.rotations = [...patch.rotations];
    return next;
  });
}

/** Remembers the material/thickness the operator last entered, for the next new rows. */
export function nextLineDefaults(defaults: LineDefaults, patch: { material?: string; thickness?: number | null }): LineDefaults {
  return {
    material: patch.material ? patch.material : defaults.material,
    thickness: patch.thickness != null && patch.thickness > 0 ? patch.thickness : defaults.thickness,
  };
}

export const marginsEqual = (margins: Margins) =>
  margins.left === margins.right && margins.left === margins.bottom && margins.left === margins.top;

const hasAnyValue = (memory: SheetMemory) =>
  memory.gap != null || Object.values(memory.margins).some((value) => value != null);

/** Records the sheet's margins/gap as the operator's values for its preset. */
export function rememberSheet(
  memory: Partial<Record<SheetPreset, SheetMemory>>,
  sheet: SheetSettings,
): Partial<Record<SheetPreset, SheetMemory>> {
  const entry: SheetMemory = { margins: { ...sheet.margins }, gap: sheet.gap, linkMargins: sheet.linkMargins };
  if (!hasAnyValue(entry)) return memory;
  return { ...memory, [sheet.preset]: entry };
}

/**
 * The sheet after switching to `preset`: the preset's size, and the margins
 * and gap the operator last used with it. A preset never used before keeps
 * the values currently entered; nothing is pre-filled from elsewhere.
 */
export function sheetForPreset(
  sheet: SheetSettings,
  memory: Partial<Record<SheetPreset, SheetMemory>>,
  preset: SheetPreset,
): SheetSettings {
  const size = preset === "custom" ? { width: sheet.width, height: sheet.height } : SHEET_PRESETS[preset];
  const remembered = memory[preset];
  return {
    ...sheet,
    preset,
    width: size.width,
    height: size.height,
    ...(remembered
      ? { margins: { ...remembered.margins }, gap: remembered.gap, linkMargins: remembered.linkMargins }
      : {}),
  };
}

export const PRODUCTION_STORE_VERSION = 2;

/** The persisted part of the Production store. */
export type PersistedProduction = {
  selected: Record<string, SelectedProduct>;
  preparation: Record<string, PreparationItem>;
  lines: BatchLine[];
  sheet: SheetSettings;
  lineDefaults: LineDefaults;
  sheetMemory: Partial<Record<SheetPreset, SheetMemory>>;
  products: Record<string, ProductInfo>;
  pendingAdds: Record<string, PendingAdd>;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Upgrades saved state from older versions so the operator's selection,
 * lines and settings survive. Version 1 lacked line thumbnails, linked
 * margins, per-preset memory, remembered row values and pending additions.
 */
export function migrateProduction(persisted: unknown, version: number): PersistedProduction {
  const state = record(persisted);
  const selected = record(state.selected) as PersistedProduction["selected"];
  const rawLines = Array.isArray(state.lines) ? (state.lines as Record<string, unknown>[]) : [];
  const lines = rawLines.map((line) => {
    const productId = String(line.productId ?? "");
    const thumbnail =
      typeof line.thumbnail === "string" || line.thumbnail === null
        ? (line.thumbnail as string | null)
        : (selected[productId]?.thumbnail ?? null);
    return { ...line, thumbnail } as BatchLine;
  });
  const rawSheet = record(state.sheet);
  const margins = { left: null, right: null, bottom: null, top: null, ...record(rawSheet.margins) } as Margins;
  const sheet = {
    ...DEFAULT_SHEET,
    ...rawSheet,
    margins,
    linkMargins: typeof rawSheet.linkMargins === "boolean" ? rawSheet.linkMargins : marginsEqual(margins),
  } as SheetSettings;

  const products: Record<string, ProductInfo> = { ...(record(state.products) as Record<string, ProductInfo>) };
  for (const product of Object.values(selected))
    products[product.id] ??= { name: product.name, thumbnail: product.thumbnail ?? null };
  for (const line of lines)
    products[line.productId] ??= { name: line.productName, thumbnail: line.thumbnail };

  const sheetMemory =
    version < 2
      ? rememberSheet({}, sheet)
      : (record(state.sheetMemory) as PersistedProduction["sheetMemory"]);
  const defaults = record(state.lineDefaults);

  return {
    selected,
    preparation: record(state.preparation) as Record<string, PreparationItem>,
    lines,
    sheet,
    lineDefaults: {
      material: typeof defaults.material === "string" ? defaults.material : "",
      thickness: typeof defaults.thickness === "number" ? defaults.thickness : null,
    },
    sheetMemory,
    products,
    pendingAdds: record(state.pendingAdds) as Record<string, PendingAdd>,
  };
}
