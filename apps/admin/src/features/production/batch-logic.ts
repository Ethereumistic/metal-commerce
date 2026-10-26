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

/**
 * Limits the admin server enforces on a batch (api.ts). They are checked here
 * too, so the operator learns about them at the row that breaks them instead
 * of from a rejected request.
 */
export const LIMITS = {
  maxMm: 10_000,
  maxLines: 200,
  maxQuantity: 10_000,
  maxTotalParts: 5_000,
  maxSheets: 500,
} as const;

const count = (value: number) => value.toLocaleString("en-US");

/**
 * Reads a quantity as typed, without correcting it: "0" stays 0 and "-5"
 * stays -5 so validation can say what is wrong. Blank or non-numeric text is
 * null (no quantity entered).
 */
export function parseQuantityText(text: string): number | null {
  const trimmed = text.trim().replaceAll(/[\s,_]/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Why a row quantity cannot be used, or null when it is a valid count. */
export function quantityProblem(quantity: number | null): string | null {
  if (quantity == null) return "Enter a quantity.";
  if (!Number.isInteger(quantity))
    return `Quantity must be a whole number; ${quantity} was entered.`;
  if (quantity < 1) return `Quantity must be at least 1; ${count(quantity)} was entered.`;
  if (quantity > LIMITS.maxQuantity)
    return `At most ${count(LIMITS.maxQuantity)} per row; ${count(quantity)} was entered. Split larger runs into several batches.`;
  return null;
}

/** Problems with the batch as a whole (row count, total parts), with the row best placed to fix each. */
export function batchLimitProblems(
  lines: readonly Pick<BatchLine, "lineId" | "quantity">[],
): { lineId: string | null; message: string }[] {
  const problems: { lineId: string | null; message: string }[] = [];
  if (lines.length > LIMITS.maxLines)
    problems.push({
      lineId: null,
      message: `A batch holds at most ${LIMITS.maxLines} rows; this one has ${lines.length}. Split it into several batches.`,
    });
  let total = 0;
  let largest: { lineId: string; quantity: number } | null = null;
  for (const line of lines) {
    const quantity = line.quantity;
    if (quantity == null || !Number.isInteger(quantity) || quantity < 1) continue;
    total += quantity;
    if (!largest || quantity > largest.quantity) largest = { lineId: line.lineId, quantity };
  }
  if (total > LIMITS.maxTotalParts)
    problems.push({
      lineId: largest?.lineId ?? null,
      message: `A batch holds at most ${count(LIMITS.maxTotalParts)} parts; this one has ${count(total)}. Lower the quantities or split the batch.`,
    });
  return problems;
}

/** What "add the selection to the current batch" and "start a new batch" would each produce. */
export type AddPlan = {
  selected: number;
  /** Selected products already in the batch (as a row or waiting for their master). */
  alreadyInBatch: number;
  /** Rows the add would create. */
  adding: number;
  rowsNow: number;
  rowsAfterAdd: number;
  /** Batch rows whose product is not selected; adding keeps them, a new batch drops them. */
  keptUnselected: number;
};

export function addPlan(
  selectedIds: readonly string[],
  lines: readonly Pick<BatchLine, "productId">[],
  pendingIds: readonly string[],
): AddPlan {
  const inBatch = new Set([...lines.map((line) => line.productId), ...pendingIds]);
  const selected = new Set(selectedIds);
  const alreadyInBatch = [...selected].filter((id) => inBatch.has(id)).length;
  const adding = selected.size - alreadyInBatch;
  // Pending products are never also rows (queueAdds skips products already in the batch).
  const rowsNow = lines.length + pendingIds.length;
  const keptUnselected =
    lines.filter((line) => !selected.has(line.productId)).length +
    pendingIds.filter((id) => !selected.has(id)).length;
  return { selected: selected.size, alreadyInBatch, adding, rowsNow, rowsAfterAdd: rowsNow + adding, keptUnselected };
}

/** Identity of a draft's content (not its row ids), to tell whether two drafts are the same job. */
export function draftSignature(lines: readonly NewLine[]): string {
  return JSON.stringify(
    lines.map((line) => [
      line.productId,
      line.masterId,
      line.mode,
      line.mode === "height" ? null : line.width,
      line.mode === "width" ? null : line.height,
      line.quantity,
      line.material,
      line.thickness,
      [...line.rotations].sort((a, b) => a - b),
    ]),
  );
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const asRecord = (value: Json | undefined): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const asNumber = (value: Json | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type ClonedBatch = { lines: NewLine[]; sheet: SheetSettings; skipped: number };

/**
 * A new draft from a batch's frozen request: the same products, masters,
 * sizes, quantities, materials, rotations, stock, margins, gap, sheet limit,
 * time budget, seed and name. Names and thumbnails come from what this
 * browser knows about the products. Lines the request does not describe
 * completely are skipped and counted. Null when the request has no lines.
 */
export function cloneBatchRequest(
  request: JsonRecord,
  products: Record<string, ProductInfo>,
  current: SheetSettings,
): ClonedBatch | null {
  const rawLines = Array.isArray(request.lines) ? request.lines : [];
  let skipped = 0;
  const lines: NewLine[] = [];
  for (const raw of rawLines) {
    const line = asRecord(raw);
    const size = asRecord(line?.size);
    const productId = typeof line?.product_id === "string" ? line.product_id : null;
    const masterId = typeof line?.master_id === "string" ? line.master_id : null;
    const mode = size?.mode === "width" || size?.mode === "height" || size?.mode === "fit" ? size.mode : null;
    const rotations = Array.isArray(line?.allowed_rotations)
      ? ALL_ROTATIONS.filter((rotation) => (line.allowed_rotations as Json[]).includes(rotation))
      : [];
    if (!line || !productId || !masterId || !mode || !rotations.length) {
      skipped += 1;
      continue;
    }
    const known = products[productId];
    lines.push({
      productId,
      productName: known?.name ?? "Product from an earlier batch",
      thumbnail: known?.thumbnail ?? null,
      masterId,
      mode,
      width: asNumber(size?.width_mm),
      height: asNumber(size?.height_mm),
      quantity: asNumber(line.quantity),
      material: typeof line.material === "string" ? line.material : "",
      thickness: asNumber(line.thickness_mm),
      rotations,
    });
  }
  if (!lines.length) return null;

  const stock = asRecord(request.stock);
  const margins = asRecord(stock?.margins_mm);
  const optimization = asRecord(request.optimization);
  const width = asNumber(stock?.width_mm) ?? current.width;
  const height = asNumber(stock?.height_mm) ?? current.height;
  const preset: SheetPreset =
    width === SHEET_PRESETS.current.width && height === SHEET_PRESETS.current.height
      ? "current"
      : width === SHEET_PRESETS.future.width && height === SHEET_PRESETS.future.height
        ? "future"
        : "custom";
  const sheetMargins: Margins = {
    left: asNumber(margins?.left),
    right: asNumber(margins?.right),
    bottom: asNumber(margins?.bottom),
    top: asNumber(margins?.top),
  };
  const budget = asNumber(optimization?.time_budget_s);
  return {
    lines,
    skipped,
    sheet: {
      ...current,
      preset,
      width,
      height,
      margins: sheetMargins,
      linkMargins: marginsEqual(sheetMargins),
      gap: asNumber(stock?.gap_mm),
      maxSheets: asNumber(stock?.max_sheets) ?? current.maxSheets,
      timeBudget: budget === 10 || budget === 30 || budget === 120 ? budget : current.timeBudget,
      seed: asNumber(optimization?.seed) ?? current.seed,
      name: typeof request.name === "string" ? request.name : "",
    },
  };
}
