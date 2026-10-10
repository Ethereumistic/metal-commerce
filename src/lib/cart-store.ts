import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  applyIntent,
  lineKey,
  MAX_LINE_QUANTITY,
  shopCall,
  ShopError,
  type CartIntent,
  type CartItem,
  type ShopErrorCode,
  type ShopState,
} from "./shop";

export type CartFlight = {
  id: number;
  image: string;
  from: { x: number; y: number; width: number; height: number };
};

type Status = "idle" | "loading" | "ready" | "error";
type CartStore = {
  /** Last server-confirmed bag. */
  confirmed: CartItem[];
  /** Confirmed bag with queued optimistic intents applied; what the UI renders. */
  items: CartItem[];
  account: ShopState["account"];
  address?: ShopState["address"];
  totals?: ShopState["totals"];
  payable?: boolean;
  status: Status;
  pending: boolean;
  error?: ShopErrorCode;
  /** Catalog card images by product; nicer than backend originals and survives reloads. */
  images: Record<string, string>;
  open: boolean;
  flight?: CartFlight;
  bump: number;
  announcement: string;
  setOpen: (open: boolean) => void;
  load: () => Promise<void>;
  accept: (state: ShopState) => void;
  add: (item: CartItem, from?: CartFlight["from"]) => void;
  setQuantity: (item: CartItem, quantity: number) => void;
  remove: (item: CartItem) => void;
  signOut: () => Promise<void>;
};

let queue: { intent: CartIntent; item?: CartItem }[] = [];
let draining = false;
let loadEpoch = 0;
let flightId = 0;

function project(confirmed: CartItem[]) {
  return queue.reduce(
    (items, { intent, item }) =>
      applyIntent(items, intent, (line) => ({ ...item!, ...line })),
    confirmed,
  );
}

export const useCart = create<CartStore>()(
  persist(
    (set, get) => {
      function withImages(state: ShopState) {
        const { images } = get();
        return state.items.map((item) => ({
          ...item,
          image: images[item.productId] ?? item.image,
        }));
      }
      function enqueue(intent: CartIntent, item?: CartItem) {
        loadEpoch++;
        const last = queue.at(-1);
        // Collapse rapid stepper clicks on the same line into one request.
        if (
          intent.kind === "quantity" &&
          queue.length > 1 &&
          last?.intent.kind === "quantity" &&
          last.intent.key === intent.key
        )
          queue[queue.length - 1] = { intent };
        else queue.push({ intent, item });
        set({
          items: project(get().confirmed),
          pending: true,
          error: undefined,
        });
        void drain();
      }
      async function drain() {
        if (draining) return;
        draining = true;
        while (queue.length) {
          const { intent } = queue[0]!;
          try {
            const state = await shopCall<ShopState>(
              "cart",
              intent as unknown as Record<string, unknown>,
            );
            queue.shift();
            get().accept(state);
          } catch (error) {
            // The request may have committed before failing: drop the queue and re-read.
            queue = [];
            set({
              error: error instanceof ShopError ? error.code : "unavailable",
            });
            try {
              get().accept(await shopCall<ShopState>("state"));
            } catch {
              set({ items: get().confirmed });
            }
          }
        }
        draining = false;
        set({ pending: false });
      }
      return {
        confirmed: [],
        items: [],
        account: null,
        status: "idle",
        pending: false,
        images: {},
        open: false,
        bump: 0,
        announcement: "",
        setOpen: (open) => set({ open }),
        accept: (state) => {
          const confirmed = withImages(state);
          set({
            confirmed,
            items: project(confirmed),
            account: state.account,
            address: state.address,
            totals: state.totals,
            payable: state.payable,
            status: "ready",
          });
        },
        load: async () => {
          if (draining || queue.length) return;
          const epoch = ++loadEpoch;
          set({ status: get().status === "ready" ? "ready" : "loading" });
          try {
            const state = await shopCall<ShopState>("state");
            if (epoch === loadEpoch) get().accept(state);
          } catch (error) {
            if (epoch === loadEpoch)
              set({
                status: "error",
                error: error instanceof ShopError ? error.code : "unavailable",
              });
          }
        },
        add: (item, from) => {
          set((state) => ({
            images: item.image
              ? { ...state.images, [item.productId]: item.image }
              : state.images,
            bump: state.bump + 1,
            announcement: item.name,
            flight:
              from && item.image
                ? { id: ++flightId, image: item.image, from }
                : state.flight,
          }));
          enqueue(
            {
              kind: "add",
              line: {
                productId: item.productId,
                variantKey: item.variantKey,
                quantity: item.quantity,
                answers: item.answers,
              },
            },
            item,
          );
        },
        setQuantity: (item, quantity) => {
          if (
            Number.isSafeInteger(quantity) &&
            quantity >= 1 &&
            quantity <= MAX_LINE_QUANTITY &&
            quantity !== item.quantity
          )
            enqueue({ kind: "quantity", key: lineKey(item), quantity });
        },
        remove: (item) => enqueue({ kind: "remove", key: lineKey(item) }),
        signOut: async () => {
          get().accept(await shopCall<ShopState>("signOut"));
        },
      };
    },
    {
      name: "metal-craft-bag",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Persist only display data for an instant first paint; the server bag stays authoritative.
      partialize: (state) => ({
        confirmed: state.confirmed,
        images: state.images,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<CartStore> | undefined;
        const confirmed = Array.isArray(saved?.confirmed) ? saved.confirmed : [];
        return {
          ...current,
          images: saved?.images ?? {},
          confirmed: current.status === "ready" ? current.confirmed : confirmed,
          items: current.status === "ready" ? current.items : confirmed,
        };
      },
      skipHydration: true,
    },
  ),
);

export function cartCount(items: CartItem[]) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}
export function cartSubtotal(items: CartItem[]) {
  return items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
}
