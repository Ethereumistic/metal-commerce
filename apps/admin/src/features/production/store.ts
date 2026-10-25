import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  BatchDraft,
  CatalogCard,
  Master,
  PreparationItem,
  Rotation,
  SizeMode,
  TimeBudget,
} from "./contracts";

// Browser-side working state of the Production workspace: the operator's
// selection, batch lines and sheet settings survive a reload. Jobs, masters
// and batches themselves live on the artwork service; nothing here is the
// source of truth for them.

export type SelectedProduct = Pick<CatalogCard, "id" | "slug" | "name" | "thumbnail" | "revision">;

export type BatchLine = {
  lineId: string;
  productId: string;
  productName: string;
  masterId: string;
  mode: SizeMode;
  width: number | null;
  height: number | null;
  quantity: number | null;
  material: string;
  thickness: number | null;
  rotations: Rotation[];
};

export type Margins = { left: number | null; right: number | null; bottom: number | null; top: number | null };

export type SheetPreset = "current" | "future" | "custom";

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

export type SheetSettings = {
  preset: SheetPreset;
  width: number;
  height: number;
  margins: Margins;
  gap: number | null;
  maxSheets: number | null;
  timeBudget: TimeBudget;
  seed: number;
  name: string;
};

type ProductionState = {
  selected: Record<string, SelectedProduct>;
  preparation: Record<string, PreparationItem>;
  masters: Record<string, Master>;
  lines: BatchLine[];
  sheet: SheetSettings;
  /** The service's validation of the current lines + sheet; cleared by any edit. */
  draft: BatchDraft | null;

  toggle: (product: SelectedProduct, selected: boolean) => void;
  clearSelection: () => void;
  setPreparation: (items: PreparationItem[]) => void;
  setMaster: (master: Master) => void;
  addLine: (line: Omit<BatchLine, "lineId">) => void;
  updateLine: (lineId: string, patch: Partial<Omit<BatchLine, "lineId">>) => void;
  duplicateLine: (lineId: string) => void;
  removeLine: (lineId: string) => void;
  updateSheet: (patch: Partial<SheetSettings>) => void;
  setDraft: (draft: BatchDraft | null) => void;
};

const newLineId = () => crypto.randomUUID().replaceAll("-", "");

export const useProduction = create<ProductionState>()(
  persist(
    (set) => ({
      selected: {},
      preparation: {},
      masters: {},
      lines: [],
      sheet: {
        preset: "current",
        width: SHEET_PRESETS.current.width,
        height: SHEET_PRESETS.current.height,
        // Margins and gap are workshop settings nobody has confirmed yet; the
        // operator enters them for every batch.
        margins: { left: null, right: null, bottom: null, top: null },
        gap: null,
        maxSheets: 10,
        timeBudget: 30,
        seed: 1,
        name: "",
      },
      draft: null,

      toggle: (product, selected) =>
        set((state) => {
          const next = { ...state.selected };
          if (selected) next[product.id] = product;
          else delete next[product.id];
          return { selected: next };
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
      addLine: (line) =>
        set((state) => ({ lines: [...state.lines, { ...line, lineId: newLineId() }], draft: null })),
      updateLine: (lineId, patch) =>
        set((state) => ({
          lines: state.lines.map((line) => (line.lineId === lineId ? { ...line, ...patch } : line)),
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
      updateSheet: (patch) => set((state) => ({ sheet: { ...state.sheet, ...patch }, draft: null })),
      setDraft: (draft) => set({ draft }),
    }),
    {
      name: "metal-admin-production",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        selected: state.selected,
        preparation: state.preparation,
        lines: state.lines,
        sheet: state.sheet,
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
