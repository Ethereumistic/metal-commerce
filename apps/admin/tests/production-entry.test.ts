import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyToLines,
  migrateProduction,
  newLine,
  nextLineDefaults,
  rememberSheet,
  sheetForPreset,
  withoutDuplicates,
} from "../src/features/production/batch-logic.ts";
import { createDebouncedStorage } from "../src/features/production/persist-storage.ts";
import type { BatchLine, SheetSettings } from "../src/features/production/store.ts";

function memoryStorage() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  } as Storage;
  return { storage, data, writes };
}

function manualTimers() {
  let pending: (() => void) | null = null;
  return {
    timers: {
      set: (callback: () => void) => {
        pending = callback;
        return 1;
      },
      clear: () => {
        pending = null;
      },
    },
    fire: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    get scheduled() {
      return pending != null;
    },
  };
}

test("debounced storage writes once after a burst and serves the pending value", () => {
  const { storage, data, writes } = memoryStorage();
  const clock = manualTimers();
  const persisted = createDebouncedStorage<{ width: number }>(() => storage, 300, clock.timers);
  for (let width = 1; width <= 20; width++) persisted.setItem("production", { state: { width }, version: 2 });
  assert.equal(writes.length, 0, "nothing is written while typing");
  assert.deepEqual(persisted.getItem("production"), { state: { width: 20 }, version: 2 });
  clock.fire();
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(data.get("production")!), { state: { width: 20 }, version: 2 });
});

test("flush writes immediately and cancels the timer", () => {
  const { storage, data, writes } = memoryStorage();
  const clock = manualTimers();
  const persisted = createDebouncedStorage<{ n: number }>(() => storage, 300, clock.timers);
  persisted.setItem("production", { state: { n: 1 }, version: 2 });
  persisted.flush();
  assert.equal(writes.length, 1);
  assert.equal(clock.scheduled, false);
  assert.equal(JSON.parse(data.get("production")!).state.n, 1);
  persisted.flush();
  assert.equal(writes.length, 1, "a second flush with nothing pending writes nothing");
});

test("debounced storage reads existing values and survives missing storage", () => {
  const { storage, data } = memoryStorage();
  data.set("production", JSON.stringify({ state: { n: 3 }, version: 1 }));
  const persisted = createDebouncedStorage<{ n: number }>(() => storage);
  assert.deepEqual(persisted.getItem("production"), { state: { n: 3 }, version: 1 });

  const unavailable = createDebouncedStorage<{ n: number }>(() => {
    throw new ReferenceError("localStorage is not defined");
  });
  assert.equal(unavailable.getItem("production"), null);
  unavailable.setItem("production", { state: { n: 1 } });
  assert.doesNotThrow(() => unavailable.flush());
});

const line = (overrides: Partial<BatchLine> = {}): BatchLine => ({
  lineId: "l1",
  productId: "p1",
  productName: "Moose",
  thumbnail: null,
  masterId: "m1",
  mode: "width",
  width: null,
  height: null,
  quantity: null,
  material: "",
  thickness: null,
  rotations: [0, 90, 180, 270],
  ...overrides,
});

test("adding products never duplicates one already in the batch or repeated in the request", () => {
  const defaults = { material: "", thickness: null };
  const existing = [line({ productId: "p1", width: 300 })];
  const candidates = [
    newLine({ id: "p1", name: "Moose", thumbnail: null }, "m1", defaults),
    newLine({ id: "p2", name: "Bear", thumbnail: "https://img/bear.jpg" }, "m2", defaults),
    newLine({ id: "p2", name: "Bear", thumbnail: "https://img/bear.jpg" }, "m2", defaults),
  ];
  const added = withoutDuplicates(existing, candidates);
  assert.deepEqual(
    added.map((entry) => entry.productId),
    ["p2"],
  );
  assert.equal(added[0]!.thumbnail, "https://img/bear.jpg");
});

test("new rows take only the operator's own last material and thickness", () => {
  const blank = newLine({ id: "p1", name: "Moose", thumbnail: null }, "m1", { material: "", thickness: null });
  assert.equal(blank.material, "");
  assert.equal(blank.thickness, null);
  assert.equal(blank.quantity, null);
  const remembered = nextLineDefaults({ material: "", thickness: null }, { material: "Steel", thickness: 2 });
  assert.deepEqual(remembered, { material: "Steel", thickness: 2 });
  assert.deepEqual(nextLineDefaults(remembered, { material: "", thickness: null }), remembered, "clearing a row keeps the memory");
  const next = newLine({ id: "p2", name: "Bear", thumbnail: null }, "m2", remembered);
  assert.equal(next.material, "Steel");
  assert.equal(next.thickness, 2);
});

test("apply to all/selected sets only filled values and keeps other rows untouched", () => {
  const lines = [
    line({ lineId: "a", mode: "height", height: 400 }),
    line({ lineId: "b", quantity: 7 }),
    line({ lineId: "c" }),
  ];
  const selected = applyToLines(lines, new Set(["a", "b"]), { width: 300, material: "Steel" });
  assert.equal(selected[0]!.width, 300);
  assert.equal(selected[0]!.mode, "width", "a width makes a height-driven row width-driven");
  assert.equal(selected[1]!.quantity, 7, "quantity was not in the patch");
  assert.equal(selected[1]!.material, "Steel");
  assert.equal(selected[2], lines[2], "unselected rows keep their identity");

  const all = applyToLines(lines, null, { quantity: 2, thickness: 3, rotations: [0, 180] });
  assert.ok(all.every((entry) => entry.quantity === 2 && entry.thickness === 3));
  assert.deepEqual(all[2]!.rotations, [0, 180]);
  assert.notEqual(all[2]!.rotations, lines[2]!.rotations);

  const none = applyToLines(lines, null, {});
  assert.ok(none.every((entry, index) => entry === lines[index]));
});

const sheet = (overrides: Partial<SheetSettings> = {}): SheetSettings => ({
  preset: "current",
  width: 1500,
  height: 3000,
  margins: { left: null, right: null, bottom: null, top: null },
  linkMargins: true,
  gap: null,
  maxSheets: 10,
  timeBudget: 30,
  seed: 1,
  name: "",
  ...overrides,
});

test("margins and gap are remembered per sheet preset", () => {
  const current = sheet({ margins: { left: 10, right: 10, bottom: 10, top: 10 }, gap: 5 });
  let memory = rememberSheet({}, current);
  const future = sheetForPreset(current, memory, "future");
  assert.equal(future.width, 2000);
  assert.equal(future.height, 4000);
  assert.deepEqual(future.margins, current.margins, "an unused preset keeps the values entered");

  const futureEdited = { ...future, margins: { left: 20, right: 15, bottom: 20, top: 20 }, gap: 8, linkMargins: false };
  memory = rememberSheet(memory, futureEdited);
  const back = sheetForPreset(futureEdited, memory, "current");
  assert.equal(back.width, 1500);
  assert.deepEqual(back.margins, { left: 10, right: 10, bottom: 10, top: 10 });
  assert.equal(back.gap, 5);
  assert.equal(back.linkMargins, true);
  const again = sheetForPreset(back, memory, "future");
  assert.deepEqual(again.margins, { left: 20, right: 15, bottom: 20, top: 20 });
  assert.equal(again.gap, 8);

  assert.deepEqual(rememberSheet(memory, sheet({ preset: "custom" })), memory, "blank values are not remembered");
  const custom = sheetForPreset(sheet({ width: 1000, height: 2000 }), memory, "custom");
  assert.equal(custom.width, 1000, "custom keeps the entered size");
});

test("version 1 saved state migrates without losing the operator's work", () => {
  const v1 = {
    selected: {
      p1: { id: "p1", slug: "moose", name: "Moose", thumbnail: "https://img/moose.jpg", revision: 3 },
    },
    preparation: { p1: { product_id: "p1", status: "ready", master_id: "m1", job_id: null, error: null } },
    lines: [
      {
        lineId: "l1",
        productId: "p1",
        productName: "Moose",
        masterId: "m1",
        mode: "width",
        width: 300,
        height: null,
        quantity: 2,
        material: "Steel",
        thickness: 2,
        rotations: [0, 90],
      },
      {
        lineId: "l2",
        productId: "p9",
        productName: "Owl",
        masterId: "m9",
        mode: "fit",
        width: 100,
        height: 100,
        quantity: 1,
        material: "Aluminium",
        thickness: 1,
        rotations: [0],
      },
    ],
    sheet: {
      preset: "current",
      width: 1500,
      height: 3000,
      margins: { left: 10, right: 10, bottom: 10, top: 10 },
      gap: 5,
      maxSheets: 10,
      timeBudget: 30,
      seed: 1,
      name: "Week 43",
    },
  };
  const migrated = migrateProduction(structuredClone(v1), 1);
  assert.equal(migrated.lines.length, 2);
  assert.equal(migrated.lines[0]!.width, 300);
  assert.equal(migrated.lines[0]!.thumbnail, "https://img/moose.jpg", "thumbnail comes from the saved selection");
  assert.equal(migrated.lines[1]!.thumbnail, null);
  assert.equal(migrated.sheet.name, "Week 43");
  assert.equal(migrated.sheet.gap, 5);
  assert.equal(migrated.sheet.linkMargins, true, "equal margins start linked");
  assert.deepEqual(migrated.sheetMemory.current, {
    margins: { left: 10, right: 10, bottom: 10, top: 10 },
    gap: 5,
    linkMargins: true,
  });
  assert.deepEqual(migrated.lineDefaults, { material: "", thickness: null }, "no invented defaults");
  assert.deepEqual(migrated.products.p1, { name: "Moose", thumbnail: "https://img/moose.jpg" });
  assert.deepEqual(migrated.products.p9, { name: "Owl", thumbnail: null });
  assert.deepEqual(migrated.pendingAdds, {});
  assert.deepEqual(migrated.selected, v1.selected);
  assert.deepEqual(migrated.preparation, v1.preparation);

  const unequal = migrateProduction(
    { ...v1, sheet: { ...v1.sheet, margins: { left: 10, right: 5, bottom: 10, top: 10 } } },
    1,
  );
  assert.equal(unequal.sheet.linkMargins, false);

  const empty = migrateProduction(undefined, 1);
  assert.deepEqual(empty.lines, []);
  assert.deepEqual(empty.sheetMemory, {});
});
