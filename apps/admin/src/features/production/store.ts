import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_SHEET,
  MATERIALS,
  PRODUCTION_STORE_VERSION,
  SHEET_PRESETS,
  THICKNESS_CEILINGS_MM,
  applyToLines,
  migrateProduction,
  nextLineDefaults,
  rememberSheet,
  sheetForPreset,
  withoutDuplicates,
  type BulkPatch,
  type NewLine,
  type PersistedProduction,
} from "./batch-logic";
import type {
  BatchDraft,
  CatalogCard,
  Master,
  PreparationItem,
  Rotation,
  SizeMode,
  TimeBudget,
} from "./contracts";
import { createDebouncedStorage, flushWhenHidden } from "./persist-storage";

export { MATERIALS, SHEET_PRESETS, THICKNESS_CEILINGS_MM };

// Browser-side working state of the Production workspace: the operator's
// selection, batch lines and sheet settings survive a reload. Jobs, masters
// and batches themselves live on the artwork service; nothing here is the
// source of truth for them.

export type SelectedProduct = Pick<CatalogCard, "id" | "slug" | "name" | "thumbnail" | "revision">;

/** Name and first-image thumbnail of a product, kept so later steps can show it. */
export type ProductInfo = { name: string; thumbnail: string | null };

export type BatchLine = {
  lineId: string;
  productId: string;
  productName: string;
  /** The catalog thumbnail when the line was added (null when the product had none). */
  thumbnail: string | null;
  masterId: string;
  mode: SizeMode;
  width: number | null;
  height: number | null;
  quantity: number | null;
  material: string;
  thickness: number | null;
  rotations: Rotation[];
};

/** A selected product that joins the batch as soon as its master is ready. */
export type PendingAdd = { productId: string; name: string; thumbnail: string | null };

/** The operator's last-entered material and thickness, used for new rows. */
export type LineDefaults = { material: string; thickness: number | null };

export type Margins = { left: number | null; right: number | null; bottom: number | null; top: number | null };

export type SheetPreset = "current" | "future" | "custom";

export type SheetMemory = { margins: Margins; gap: number | null; linkMargins: boolean };

export type SheetSettings = {
  preset: SheetPreset;
  width: number;
  height: number;
  margins: Margins;
  /** One margin value for all four sides. */
  linkMargins: boolean;
  gap: number | null;
  maxSheets: number | null;
  timeBudget: TimeBudget;
  seed: number;
  name: string;
};

type ProductionState = PersistedProduction & {
  masters: Record<string, Master>;
  /** The service's validation of the current lines + sheet; cleared by any edit. */
  draft: BatchDraft | null;
  /** Whether following trace jobs currently fails because the service is unreachable. */
  tracePollOffline: boolean;

  toggle: (product: SelectedProduct, selected: boolean) => void;
  clearSelection: () => void;
  setPreparation: (items: PreparationItem[]) => void;
  setMaster: (master: Master) => void;
  /** Adds lines, skipping products already in the batch; returns how many were added. */
  addLines: (lines: NewLine[]) => number;
  updateLine: (lineId: string, patch: Partial<Omit<BatchLine, "lineId">>) => void;
  applyToLines: (ids: ReadonlySet<string> | null, patch: BulkPatch) => void;
  duplicateLine: (lineId: string) => void;
  removeLine: (lineId: string) => void;
  queueAdds: (products: PendingAdd[]) => void;
  dropPendingAdd: (productId: string) => void;
  updateSheet: (patch: Partial<SheetSettings>) => void;
  choosePreset: (preset: SheetPreset) => void;
  setDraft: (draft: BatchDraft | null) => void;
  setTracePollOffline: (offline: boolean) => void;
};

const newLineId = () => crypto.randomUUID().replaceAll("-", "");

const storage = createDebouncedStorage<PersistedProduction>(() => localStorage);
flushWhenHidden(storage.flush);

/** Writes the debounced working state now (before navigating between steps). */
export const flushProductionState = storage.flush;

/** Products to remember by id for thumbnails/names in later steps. */
const withProducts = (
  products: Record<string, ProductInfo>,
  entries: { id: string; name: string; thumbnail: string | null }[],
) => {
  if (!entries.length) return products;
  const next = { ...products };
  for (const entry of entries) next[entry.id] = { name: entry.name, thumbnail: entry.thumbnail };
  return next;
};

export const useProduction = create<ProductionState>()(
  persist(
    (set, get) => ({
      selected: {},
      preparation: {},
      masters: {},
      lines: [],
      sheet: DEFAULT_SHEET,
      lineDefaults: { material: "", thickness: null },
      sheetMemory: {},
      products: {},
      pendingAdds: {},
      draft: null,
      tracePollOffline: false,

      toggle: (product, selected) =>
        set((state) => {
          const next = { ...state.selected };
          if (selected) next[product.id] = product;
          else delete next[product.id];
          return {
            selected: next,
            products: selected ? withProducts(state.products, [product]) : state.products,
          };
        }),
      clearSelection: () => set({ selected: {} }),
      setPreparation: (items) =>
        set((state) => ({
          preparation: {
            ...state.preparation,
            ...Object.fromEntries(items.map((item) => [item.product_id, item])),
          },
        })),
      setMaster: (master) =>
        set((state) => ({ masters: { ...state.masters, [master.id]: master } })),
      addLines: (candidates) => {
        const added = withoutDuplicates(get().lines, candidates);
        if (!added.length) return 0;
        set((state) => {
          const pendingAdds = { ...state.pendingAdds };
          for (const line of added) delete pendingAdds[line.productId];
          return {
            lines: [...state.lines, ...added.map((line) => ({ ...line, lineId: newLineId() }))],
            products: withProducts(
              state.products,
              added.map((line) => ({ id: line.productId, name: line.productName, thumbnail: line.thumbnail })),
            ),
            pendingAdds,
            draft: null,
          };
        });
        return added.length;
      },
      updateLine: (lineId, patch) =>
        set((state) => ({
          lines: state.lines.map((line) => (line.lineId === lineId ? { ...line, ...patch } : line)),
          lineDefaults: nextLineDefaults(state.lineDefaults, patch),
          draft: null,
        })),
      applyToLines: (ids, patch) =>
        set((state) => ({
          lines: applyToLines(state.lines, ids, patch),
          lineDefaults: nextLineDefaults(state.lineDefaults, patch),
          draft: null,
        })),
      duplicateLine: (lineId) =>
        set((state) => {
          const index = state.lines.findIndex((line) => line.lineId === lineId);
          if (index < 0) return {};
          const copy = { ...state.lines[index]!, lineId: newLineId() };
          const lines = [...state.lines];
          lines.splice(index + 1, 0, copy);
          return { lines, draft: null };
        }),
      removeLine: (lineId) =>
        set((state) => ({ lines: state.lines.filter((line) => line.lineId !== lineId), draft: null })),
      queueAdds: (products) =>
        set((state) => {
          const inBatch = new Set(state.lines.map((line) => line.productId));
          const waiting = products.filter((product) => !inBatch.has(product.productId));
          if (!waiting.length) return {};
          return {
            pendingAdds: {
              ...state.pendingAdds,
              ...Object.fromEntries(waiting.map((product) => [product.productId, product])),
            },
            products: withProducts(
              state.products,
              waiting.map((product) => ({ id: product.productId, name: product.name, thumbnail: product.thumbnail })),
            ),
          };
        }),
      dropPendingAdd: (productId) =>
        set((state) => {
          const pendingAdds = { ...state.pendingAdds };
          delete pendingAdds[productId];
          return { pendingAdds };
        }),
      updateSheet: (patch) =>
        set((state) => {
          const sheet = { ...state.sheet, ...patch };
          const remembers = "margins" in patch || "gap" in patch || "linkMargins" in patch;
          return {
            sheet,
            sheetMemory: remembers ? rememberSheet(state.sheetMemory, sheet) : state.sheetMemory,
            draft: null,
          };
        }),
      choosePreset: (preset) =>
        set((state) => ({ sheet: sheetForPreset(state.sheet, state.sheetMemory, preset), draft: null })),
      setDraft: (draft) => set({ draft }),
      setTracePollOffline: (offline) => set((state) => (state.tracePollOffline === offline ? state : { tracePollOffline: offline })),
    }),
    {
      name: "metal-admin-production",
      version: PRODUCTION_STORE_VERSION,
      storage,
      migrate: migrateProduction,
      partialize: (state): PersistedProduction => ({
        selected: state.selected,
        preparation: state.preparation,
        lines: state.lines,
        sheet: state.sheet,
        lineDefaults: state.lineDefaults,
        sheetMemory: state.sheetMemory,
        products: state.products,
        pendingAdds: state.pendingAdds,
      }),
    },
  ),
);

const ACTIVE_KEY = "metal-admin-production-active";

export type ActiveRun = { jobId: string; batchId: string | null };

/** The last accepted nesting job, so a reload resumes it instead of submitting again. */
export function readActiveRun(): ActiveRun | null {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "null") as ActiveRun | null;
    return value && typeof value.jobId === "string" ? value : null;
  } catch {
    return null;
  }
}

export function writeActiveRun(run: ActiveRun | null) {
  try {
    if (run) localStorage.setItem(ACTIVE_KEY, JSON.stringify(run));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the URL still carries the job.
  }
}
