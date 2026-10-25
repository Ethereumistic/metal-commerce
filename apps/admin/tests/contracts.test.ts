import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContractError,
  errorEnvelope,
  parseBatch,
  parseBatchDraft,
  parseHealth,
  parseJob,
  parseJobs,
  parseMaster,
  parsePreparationItems,
} from "../src/features/production/contracts.ts";
import { actualSize } from "../src/features/production/sizing.ts";

const job = {
  id: "job1",
  kind: "nest",
  status: "running",
  stage: "optimizing",
  progress: 0.4,
  heartbeat_at: "2026-10-25T10:00:00Z",
  attempts: 1,
  cache_hit: false,
  error: null,
  result: null,
  created_at: "2026-10-25T09:59:00Z",
  updated_at: "2026-10-25T10:00:00Z",
};

test("health responses are validated field by field", () => {
  const health = {
    service_version: "0.1.0",
    worker_ready: true,
    queue: { queued: 0, running: 1 },
    tracer_version: "t1",
    solver_version: "s1",
    exporter_version: "e1",
  };
  assert.deepEqual(parseHealth(health), health);
  assert.throws(
    () => parseHealth({ ...health, worker_ready: "yes" }),
    (error: unknown) =>
      error instanceof ContractError && error.path === "health.worker_ready",
  );
});

test("preparation items accept only contract statuses", () => {
  const items = parsePreparationItems({
    items: [
      { product_id: "p1", status: "queued", master_id: null, job_id: "j1", error: null },
      {
        product_id: "p2",
        status: "failed",
        master_id: null,
        job_id: null,
        error: { code: "NO_FIRST_IMAGE", message: "No image" },
      },
    ],
  });
  assert.equal(items[1]?.error?.code, "NO_FIRST_IMAGE");
  assert.throws(() =>
    parsePreparationItems({
      items: [{ product_id: "p1", status: "done", master_id: null, job_id: null, error: null }],
    }),
  );
  assert.throws(() => parsePreparationItems({ results: [] }));
});

test("masters require a positive aspect ratio", () => {
  const master = {
    id: "m1",
    product_id: "p1",
    revision: 1,
    source: { byte_sha256: "abc" },
    aspect_ratio: 1.5,
    normalized_bounds: [0, 0, 1.5, 1],
    components: 1,
    holes: 2,
    vertex_count: 300,
    trace_engine: "opencv",
    trace_version: "1",
    trace_settings: {},
    diagnostics: { threshold: 128, candidates: [], noise_removed_area_px: 10, warnings: ["w"] },
    artifacts: { overlay_png: "a1", solid_png: "a2", master_json: "a3", master_svg: null },
    created_at: "2026-10-25T10:00:00Z",
  };
  assert.equal(parseMaster(master).aspect_ratio, 1.5);
  assert.throws(() => parseMaster({ ...master, aspect_ratio: 0 }));
  assert.throws(() => parseMaster({ ...master, artifacts: undefined }));
});

test("jobs validate progress bounds and result ids", () => {
  assert.equal(parseJob(job).stage, "optimizing");
  assert.throws(() => parseJob({ ...job, progress: 1.2 }));
  assert.deepEqual(
    parseJob({ ...job, status: "succeeded", progress: 1, result: { batch_id: "b1" } }).result,
    { batch_id: "b1" },
  );
  assert.equal(parseJobs([job]).length, 1);
  assert.equal(parseJobs({ items: [job] }).length, 1);
  assert.throws(() => parseJobs({ nope: [] }));
});

test("batch drafts carry per-line fit results", () => {
  const draft = parseBatchDraft({
    batch_id: "b1",
    status: "invalid",
    lines: [
      {
        line_id: "l1",
        actual_width_mm: 1500,
        actual_height_mm: 1500,
        fits: false,
        errors: [{ code: "PART_DOES_NOT_FIT", message: "Too wide", details: { usable_width_mm: 1480 } }],
      },
    ],
    groups: [{ group_key: "steel-2", material: "steel", thickness_mm: 2, line_ids: ["l1"], instance_count: 4 }],
  });
  assert.equal(draft.lines[0]?.errors[0]?.code, "PART_DOES_NOT_FIT");
  assert.throws(() => parseBatchDraft({ batch_id: "b1", status: "nesting", lines: [], groups: [] }));
});

test("a ZIP is only exposed for completed batches", () => {
  const batch = {
    batch_id: "b1",
    status: "incomplete",
    request: {},
    groups: [],
    sheets: [
      {
        sheet_id: "s1",
        group_key: "g",
        index: 0,
        width_mm: 1500,
        height_mm: 3000,
        placements: [{ instance_id: "l1#0001", line_id: "l1", product_id: "p1", rotation_deg: 90, tx_mm: 10, ty_mm: 20 }],
        metrics: {},
      },
    ],
    totals: null,
    validation: null,
    artifacts: { zip: "zip1", manifest: "m1", sheets: [{ sheet_id: "s1", dxf: "d1", svg: "v1" }] },
  };
  assert.equal(parseBatch(batch).artifacts.zip, null);
  assert.equal(parseBatch({ ...batch, status: "completed" }).artifacts.zip, "zip1");
  assert.throws(() =>
    parseBatch({ ...batch, sheets: [{ ...batch.sheets[0], placements: [{ instance_id: "x" }] }] }),
  );
});

test("error envelopes are recognised and anything else is not", () => {
  assert.deepEqual(errorEnvelope({ error: { code: "FORBIDDEN", message: "No" } }), {
    code: "FORBIDDEN",
    message: "No",
  });
  assert.equal(errorEnvelope({ detail: "Not Found" }), null);
  assert.equal(errorEnvelope("oops"), null);
});

test("actual size follows the master's aspect ratio in every mode", () => {
  assert.deepEqual(actualSize(2, { mode: "width", width: 600, height: null }), { width: 600, height: 300 });
  assert.deepEqual(actualSize(2, { mode: "height", width: null, height: 300 }), { width: 600, height: 300 });
  // Fit inside 600 × 600: a 2:1 part is limited by width.
  assert.deepEqual(actualSize(2, { mode: "fit", width: 600, height: 600 }), { width: 600, height: 300 });
  // Fit inside 600 × 200: limited by height.
  assert.deepEqual(actualSize(2, { mode: "fit", width: 600, height: 200 }), { width: 400, height: 200 });
  assert.equal(actualSize(2, { mode: "width", width: null, height: 100 }), null);
  assert.equal(actualSize(2, { mode: "fit", width: 600, height: 0 }), null);
});
