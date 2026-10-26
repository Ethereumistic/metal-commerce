import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SHEET,
  LIMITS,
  addPlan,
  batchLimitProblems,
  cloneBatchRequest,
  draftSignature,
  newLine,
  parseQuantityText,
  quantityProblem,
} from "../src/features/production/batch-logic.ts";
import { parseBatch, type Batch, type Health } from "../src/features/production/contracts.ts";
import {
  WORKER_GRACE_MS,
  describeHealth,
  formatDuration,
  STATUS_STALL_MS,
  groupSummaries,
  healthFreshness,
  leftoverSummary,
  leftoverText,
  nestPhase,
  plural,
  qualification,
  sheetNumbers,
  shortOfSheets,
  suggestedSheetLimit,
} from "../src/features/production/results-logic.ts";

const samples = JSON.parse(
  readFileSync(new URL("./fixtures/service-responses.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

test("typed quantities are read as entered, never corrected", () => {
  assert.equal(parseQuantityText("0"), 0);
  assert.equal(parseQuantityText("-5"), -5);
  assert.equal(parseQuantityText(" 12 "), 12);
  assert.equal(parseQuantityText("1,000,000"), 1_000_000);
  assert.equal(parseQuantityText("2.5"), 2.5);
  assert.equal(parseQuantityText(""), null);
  assert.equal(parseQuantityText("abc"), null);
  assert.equal(parseQuantityText("5-"), null);
});

test("quantity problems name the rule and echo the entered value", () => {
  assert.equal(quantityProblem(1), null);
  assert.equal(quantityProblem(LIMITS.maxQuantity), null);
  assert.match(quantityProblem(null)!, /Enter a quantity/);
  assert.match(quantityProblem(0)!, /at least 1; 0 was entered/);
  assert.match(quantityProblem(-5)!, /at least 1; -5 was entered/);
  assert.match(quantityProblem(2.5)!, /whole number; 2.5 was entered/);
  assert.match(quantityProblem(1_000_000)!, /At most 10,000 per row; 1,000,000 was entered/);
});

test("batch limits point at the row that pushes the total over", () => {
  const lines = [
    { lineId: "a", quantity: 3_000 },
    { lineId: "b", quantity: 4_000 },
    { lineId: "c", quantity: 0 },
  ];
  const [problem] = batchLimitProblems(lines);
  assert.equal(problem?.lineId, "b");
  assert.match(problem!.message, /at most 5,000 parts; this one has 7,000/);
  assert.deepEqual(batchLimitProblems([{ lineId: "a", quantity: 5_000 }]), []);
  const many = Array.from({ length: LIMITS.maxLines + 1 }, (_, index) => ({ lineId: `l${index}`, quantity: 1 }));
  assert.match(batchLimitProblems(many)[0]!.message, /at most 200 rows/);
});

test("add plan separates adding to the current batch from starting a new one", () => {
  const lines = [{ productId: "flower" }, { productId: "star" }];
  // Deselected "flower" stays in the batch when adding; "star" is already there.
  const plan = addPlan(["star", "wave"], lines, ["moon"]);
  assert.deepEqual(plan, {
    selected: 2,
    alreadyInBatch: 1,
    adding: 1,
    rowsNow: 3,
    rowsAfterAdd: 4,
    keptUnselected: 2,
  });
  assert.equal(addPlan([], [], []).rowsAfterAdd, 0);
});

const frozen = {
  name: "Friday steel",
  lines: [
    {
      line_id: "l1",
      product_id: "p-star",
      master_id: "m-star",
      size: { mode: "fit", width_mm: 400, height_mm: 200 },
      quantity: 44,
      material: "Steel",
      thickness_mm: 2,
      allowed_rotations: [0, 180],
      variant_id: null,
    },
    { line_id: "broken", product_id: "p-x", size: { mode: "width" } },
  ],
  stock: {
    width_mm: 1500,
    height_mm: 3000,
    margins_mm: { left: 10, right: 10, bottom: 10, top: 10 },
    gap_mm: 5,
    max_sheets: 3,
    label: "Current machine",
  },
  optimization: { time_budget_s: 120, seed: 7 },
  export: { chord_tolerance_mm: 0.05 },
};

test("repeat clones a batch's frozen settings, not the current draft", () => {
  const current = { ...DEFAULT_SHEET, preset: "custom" as const, width: 900, height: 900, name: "Other draft", seed: 1 };
  const clone = cloneBatchRequest(frozen, { "p-star": { name: "Starburst", thumbnail: "t.png" } }, current);
  assert.ok(clone);
  assert.equal(clone.skipped, 1);
  assert.equal(clone.lines.length, 1);
  assert.deepEqual(clone.lines[0], {
    productId: "p-star",
    productName: "Starburst",
    thumbnail: "t.png",
    masterId: "m-star",
    mode: "fit",
    width: 400,
    height: 200,
    quantity: 44,
    material: "Steel",
    thickness: 2,
    rotations: [0, 180],
  });
  assert.equal(clone.sheet.preset, "current");
  assert.equal(clone.sheet.width, 1500);
  assert.deepEqual(clone.sheet.margins, { left: 10, right: 10, bottom: 10, top: 10 });
  assert.equal(clone.sheet.linkMargins, true);
  assert.equal(clone.sheet.gap, 5);
  assert.equal(clone.sheet.maxSheets, 3);
  assert.equal(clone.sheet.timeBudget, 120);
  assert.equal(clone.sheet.seed, 7);
  assert.equal(clone.sheet.name, "Friday steel");
  assert.equal(cloneBatchRequest({ lines: [] }, {}, current), null);
});

test("a cloned batch has the same signature as the draft it came from", () => {
  const clone = cloneBatchRequest(frozen, {}, DEFAULT_SHEET)!;
  const same = newLine({ id: "p-star", name: "Anything", thumbnail: null }, "m-star", { material: "Steel", thickness: 2 });
  const draft = { ...same, mode: "fit" as const, width: 400, height: 200, quantity: 44, rotations: [180, 0] as (0 | 180)[] };
  assert.equal(draftSignature(clone.lines), draftSignature([draft]));
  assert.notEqual(draftSignature(clone.lines), draftSignature([{ ...draft, quantity: 43 }]));
});

test("sheet numbers are the service's one-based numbers, used everywhere", () => {
  const sheets = [
    { sheet_id: "a", index: 1 },
    { sheet_id: "b", index: 2 },
  ];
  assert.deepEqual([...sheetNumbers(sheets).values()], [1, 2]);
  // A zero-based producer still starts at Sheet 1.
  assert.deepEqual([...sheetNumbers([{ sheet_id: "a", index: 0 }, { sheet_id: "b", index: 1 }]).values()], [1, 2]);
  const completed = parseBatch(samples.batch_completed);
  assert.equal(sheetNumbers(completed.sheets).get(completed.sheets[0]!.sheet_id), 1);
});

test("a completed batch is geometry-complete but not qualified while feature checks are unknown", () => {
  const completed = parseBatch(samples.batch_completed);
  const result = qualification(completed);
  assert.equal(result.geometry.state, "good");
  assert.equal(result.features.state, "attention");
  assert.match(result.features.detail, /not qualified/);
  assert.equal(result.readyToCut, false);

  const passed: Batch = {
    ...completed,
    lines: completed.lines.map((line) => ({ ...line, feature_check: { status: "pass", message: "" } })),
  };
  assert.equal(qualification(passed).readyToCut, true);
  const failed: Batch = { ...passed, lines: [{ ...passed.lines[0]!, feature_check: { status: "fail", message: "Bridge 0.4 mm" } }] };
  assert.equal(qualification(failed).features.state, "blocked");
  assert.equal(qualification(parseBatch(samples.batch_incomplete)).geometry.state, "blocked");
});

test("group summaries report the engine and the leftover strip in plain language", () => {
  const completed = parseBatch(samples.batch_completed);
  const [group] = groupSummaries(completed);
  assert.ok(group);
  assert.equal(group.engine, "irregular");
  assert.deepEqual(group.sheetNumbers, [1]);
  assert.ok(group.unusedAreaMm2 != null && group.unusedAreaMm2 > 0);
  assert.match(leftoverText(group), /m²/);
  const bbox = structuredClone(samples.batch_completed) as { totals: { groups: Record<string, { engine: string }> } };
  for (const outcome of Object.values(bbox.totals.groups)) outcome.engine = "bbox-baseline";
  assert.equal(groupSummaries(parseBatch(bbox))[0]?.engine, "bbox");
});

test("insufficient stock suggests a higher sheet limit", () => {
  const incomplete = parseBatch(samples.batch_incomplete);
  const limit = suggestedSheetLimit(incomplete, LIMITS.maxSheets);
  const before = (incomplete.request.stock as { max_sheets: number }).max_sheets;
  assert.ok(limit > before);
  assert.ok(limit <= LIMITS.maxSheets);
  assert.equal(typeof shortOfSheets(incomplete), "boolean");
  assert.equal(shortOfSheets(parseBatch(samples.batch_completed)), false);
});

test("nest phases read as steps a person understands", () => {
  assert.equal(nestPhase("queued", null).key, "queued");
  assert.equal(nestPhase("running", "loading").key, "preparing");
  assert.deepEqual(nestPhase("running", "nesting steel/2mm: solver"), {
    key: "solving",
    label: "Solving layout for steel/2mm",
  });
  assert.equal(nestPhase("running", "validating").key, "checking");
  assert.equal(nestPhase("running", "writing-artifacts").key, "exporting");
  assert.equal(nestPhase("succeeded", "done").key, "finished");
});

test("health distinguishes busy, starting, not responding and offline", () => {
  const health = (patch: Partial<Health>): Health => ({
    service_version: "0.1.0",
    worker_ready: true,
    queue: { queued: 0, running: 0 },
    tracer_version: "1",
    solver_version: "1",
    exporter_version: "1",
    ...patch,
  });
  const now = 1_000_000;
  assert.equal(describeHealth({ ok: true, data: health({}) }, null, now).label, "Service ready");
  assert.equal(
    describeHealth({ ok: true, data: health({ worker_ready: false, queue: { queued: 0, running: 1 } }) }, now - 999_999, now).label,
    "Busy with a job",
  );
  assert.equal(describeHealth({ ok: true, data: health({ worker_ready: false }) }, now - 1_000, now).label, "Worker starting");
  assert.equal(
    describeHealth({ ok: true, data: health({ worker_ready: false }) }, now - WORKER_GRACE_MS - 1, now).label,
    "Worker not responding",
  );
  assert.equal(describeHealth({ ok: false, offline: true }, null, now).tone, "down");
  assert.equal(describeHealth(null, null, now).tone, "unknown");
});

test("counts and durations read naturally", () => {
  assert.equal(plural(1, "part"), "1 part");
  assert.equal(plural(4, "sheet"), "4 sheets");
  assert.equal(formatDuration(42), "42 s");
  assert.equal(formatDuration(185), "3 min 05 s");
});

test("usable leftover is reported apart from metal-free area", () => {
  const raw = structuredClone(samples.batch_completed) as {
    totals: Record<string, unknown> & { groups: Record<string, { metrics: Record<string, unknown> }> };
  };
  const key = Object.keys(raw.totals.groups)[0]!;
  // Older services: no usable figure, metal-free area still known.
  const old = parseBatch(raw);
  const oldSummary = leftoverSummary(old, groupSummaries(old));
  assert.equal(oldSummary.usableMm2, null);
  assert.equal(oldSummary.metalFreeMm2, old.totals!.sheet_area_mm2 - old.totals!.metal_area_mm2);

  raw.totals.leftover_usable_area_mm2 = 6_442_440.3;
  raw.totals.leftover_usable_area_by_group_mm2 = { [key]: 6_442_440.3 };
  const current = parseBatch(raw);
  const groups = groupSummaries(current);
  assert.equal(groups[0]!.usableLeftoverMm2, 6_442_440.3);
  assert.equal(leftoverSummary(current, groups).usableMm2, 6_442_440.3);
  // The group text keeps the clear strip only; the metal-free figure lives in its own row.
  assert.doesNotMatch(leftoverText(groups[0]!), /not covered by parts/);

  // Without a batch total, the groups' own figures are summed.
  delete raw.totals.leftover_usable_area_mm2;
  delete raw.totals.leftover_usable_area_by_group_mm2;
  raw.totals.groups[key]!.metrics.leftover_usable_area_mm2 = 1_000_000;
  const fromGroups = parseBatch(raw);
  assert.equal(leftoverSummary(fromGroups, groupSummaries(fromGroups)).usableMm2, 1_000_000);
  assert.throws(() => parseBatch({ ...raw, totals: { ...raw.totals, leftover_usable_area_mm2: "big" } }));
});

test("service status says how old its reading is and when a check stalls", () => {
  const now = 1_000_000;
  assert.deepEqual(healthFreshness(now - 45_000, null, false, now), {
    stalled: false,
    text: "Last checked 45 s ago.",
  });
  assert.equal(healthFreshness(now - 45_000, now - 2_000, false, now).stalled, false);
  const stalled = healthFreshness(now - 140_000, now - STATUS_STALL_MS, false, now);
  assert.equal(stalled.stalled, true);
  assert.match(stalled.text, /Last checked 2 min 20 s ago\. The latest check is not answering\./);
  assert.equal(healthFreshness(now - 60_000, null, true, now).stalled, true);
  assert.match(healthFreshness(null, now - 20_000, false, now).text, /^Not checked yet/);
});
