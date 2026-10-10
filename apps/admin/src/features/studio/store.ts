import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import {
  createFromTemplate,
  parseDocument,
  uid,
  type Layer,
  type StudioDocument,
  type Template,
} from "./model";
import type { Sign } from "./signs";

// Designs are kept in this browser (localStorage). The document format is
// self-contained JSON, ready to be synced to a database later.

const HISTORY_LIMIT = 150;
const COALESCE_MS = 800;

type History = {
  past: StudioDocument[];
  future: StudioDocument[];
  /** Consecutive edits with the same key inside COALESCE_MS share one undo step. */
  lastKey: string | null;
  lastAt: number;
};

export type EditOptions = {
  /** Record an undo step (default true). */
  history?: boolean;
  /** Merge with the previous edit carrying the same key (e.g. typing in one field). */
  coalesce?: string;
};

export type View = {
  /** Edit the product, or preview it nested on the machine sheet. */
  mode: "design" | "sheet";
  zoom: number | "fit";
  showGuides: boolean;
  snapping: boolean;
};

type StudioState = {
  documents: Record<string, StudioDocument>;
  order: string[];
  activeId: string;
  selectedId: string | null;
  view: View;
  history: History;

  setActive: (id: string) => void;
  createDocument: (template: Template, sign?: Sign) => void;
  importDocument: (value: unknown) => void;
  duplicateDocument: (id: string) => void;
  deleteDocument: (id: string) => void;

  /** Apply a change to the active document. */
  edit: (recipe: (doc: StudioDocument) => void, options?: EditOptions) => void;
  /** Record an undo step now; follow with `edit(..., { history: false })` during a gesture. */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;

  select: (id: string | null) => void;
  addLayer: (layer: Layer) => void;
  updateLayer: <T extends Layer>(
    id: string,
    recipe: (layer: T) => void,
    options?: EditOptions,
  ) => void;
  removeLayer: (id: string) => void;
  duplicateLayer: (id: string) => void;
  /** Move a layer to a new index in the bottom-to-top stack. */
  moveLayer: (id: string, index: number) => void;

  setView: (view: Partial<View>) => void;
};

const emptyHistory = (): History => ({ past: [], future: [], lastKey: null, lastAt: 0 });

function initial() {
  const doc = createFromTemplate("icon-constellation");
  return { documents: { [doc.id]: doc }, order: [doc.id], activeId: doc.id };
}

export const useStudio = create<StudioState>()(
  persist(
    immer((set, get) => {
      /** Pushes the current active document onto the undo stack. */
      function record(state: StudioState, options: EditOptions = {}) {
        if (options.history === false) return;
        const now = Date.now();
        const history = state.history;
        if (
          options.coalesce &&
          history.lastKey === options.coalesce &&
          now - history.lastAt < COALESCE_MS
        ) {
          history.lastAt = now;
          return;
        }
        // `get()` returns the committed (non-draft) document, safe to keep.
        history.past.push(get().documents[state.activeId]!);
        if (history.past.length > HISTORY_LIMIT) history.past.shift();
        history.future = [];
        history.lastKey = options.coalesce ?? null;
        history.lastAt = now;
      }

      return {
        ...initial(),
        selectedId: null,
        view: { mode: "design", zoom: "fit", showGuides: true, snapping: true },
        history: emptyHistory(),

        setActive: (id) =>
          set((state) => {
            if (!state.documents[id]) return;
            state.activeId = id;
            state.selectedId = null;
            state.history = emptyHistory();
          }),

        createDocument: (template, sign) =>
          set((state) => {
            const doc = createFromTemplate(template, sign ?? state.documents[state.activeId]?.sign);
            state.documents[doc.id] = doc;
            state.order.unshift(doc.id);
            state.activeId = doc.id;
            state.selectedId = null;
            state.history = emptyHistory();
          }),

        importDocument: (value) => {
          const parsed = parseDocument(value);
          set((state) => {
            const doc = { ...parsed, id: uid(), updatedAt: Date.now() };
            state.documents[doc.id] = doc;
            state.order.unshift(doc.id);
            state.activeId = doc.id;
            state.selectedId = null;
            state.history = emptyHistory();
          });
        },

        duplicateDocument: (id) =>
          set((state) => {
            const source = get().documents[id];
            if (!source) return;
            const now = Date.now();
            const doc: StudioDocument = {
              ...structuredClone(source),
              id: uid(),
              name: `${source.name} copy`,
              createdAt: now,
              updatedAt: now,
            };
            state.documents[doc.id] = doc;
            state.order.splice(state.order.indexOf(id) + 1, 0, doc.id);
            state.activeId = doc.id;
            state.selectedId = null;
            state.history = emptyHistory();
          }),

        deleteDocument: (id) =>
          set((state) => {
            delete state.documents[id];
            state.order = state.order.filter((item) => item !== id);
            if (!state.order.length) {
              const doc = createFromTemplate("blank");
              state.documents[doc.id] = doc;
              state.order.push(doc.id);
            }
            if (state.activeId === id) {
              state.activeId = state.order[0]!;
              state.selectedId = null;
              state.history = emptyHistory();
            }
          }),

        edit: (recipe, options) =>
          set((state) => {
            const doc = state.documents[state.activeId];
            if (!doc) return;
            record(state, options);
            recipe(doc);
            doc.updatedAt = Date.now();
          }),

        checkpoint: () => set((state) => record(state)),

        undo: () =>
          set((state) => {
            const previous = state.history.past.pop();
            if (!previous) return;
            state.history.future.push(get().documents[state.activeId]!);
            state.documents[state.activeId] = previous;
            state.history.lastKey = null;
            if (state.selectedId && !previous.layers.some((l) => l.id === state.selectedId))
              state.selectedId = null;
          }),

        redo: () =>
          set((state) => {
            const next = state.history.future.pop();
            if (!next) return;
            state.history.past.push(get().documents[state.activeId]!);
            state.documents[state.activeId] = next;
            state.history.lastKey = null;
            if (state.selectedId && !next.layers.some((l) => l.id === state.selectedId))
              state.selectedId = null;
          }),

        select: (id) => set((state) => void (state.selectedId = id)),

        addLayer: (layer) => {
          get().edit((doc) => void doc.layers.push(layer));
          set((state) => void (state.selectedId = layer.id));
        },

        updateLayer: (id, recipe, options) =>
          get().edit((doc) => {
            const layer = doc.layers.find((item) => item.id === id);
            if (layer) recipe(layer as never);
          }, options),

        removeLayer: (id) => {
          get().edit((doc) => {
            doc.layers = doc.layers.filter((layer) => layer.id !== id);
          });
          set((state) => {
            if (state.selectedId === id) state.selectedId = null;
          });
        },

        duplicateLayer: (id) => {
          const copyId = uid();
          get().edit((doc) => {
            const index = doc.layers.findIndex((layer) => layer.id === id);
            if (index < 0) return;
            const source = doc.layers[index]!;
            doc.layers.splice(index + 1, 0, {
              ...(JSON.parse(JSON.stringify(source)) as Layer),
              id: copyId,
              name: `${source.name} copy`,
            });
          });
          set((state) => void (state.selectedId = copyId));
        },

        moveLayer: (id, index) =>
          get().edit((doc) => {
            const from = doc.layers.findIndex((layer) => layer.id === id);
            if (from < 0) return;
            const [layer] = doc.layers.splice(from, 1);
            doc.layers.splice(Math.max(0, Math.min(index, doc.layers.length)), 0, layer!);
          }),

        setView: (view) => set((state) => void Object.assign(state.view, view)),
      };
    }),
    {
      name: "metal-admin-studio",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        documents: state.documents,
        order: state.order,
        activeId: state.activeId,
        view: state.view,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<StudioState> | undefined;
        if (!saved?.documents || !saved.order?.length) return current;
        const documents: Record<string, StudioDocument> = {};
        for (const id of saved.order) {
          try {
            documents[id] = parseDocument(saved.documents[id]);
          } catch {
            // Skip unreadable designs rather than losing the rest.
          }
        }
        const order = saved.order.filter((id) => documents[id]);
        if (!order.length) return current;
        return {
          ...current,
          documents,
          order,
          activeId: saved.activeId && documents[saved.activeId] ? saved.activeId : order[0]!,
          view: { ...current.view, ...saved.view },
        };
      },
    },
  ),
);

export function useActiveDocument() {
  return useStudio((state) => state.documents[state.activeId]!);
}

export function useSelectedLayer() {
  return useStudio((state) => {
    const doc = state.documents[state.activeId];
    return doc?.layers.find((layer) => layer.id === state.selectedId) ?? null;
  });
}
