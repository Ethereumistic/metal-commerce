import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  errorEnvelope,
  parseBatch,
  parseBatchDraft,
  parseBatches,
  parseHealth,
  parseJob,
  parseJobs,
  parseMaster,
  parsePreparationItems,
} from "../src/features/production/contracts.ts";

// Real responses captured from the local artwork service by
// services/artwork-service/scripts/acceptance.py (evidence/service-responses.json),
// so the admin parsers are checked against what the service actually sends.
const samples = JSON.parse(
  readFileSync(new URL("./fixtures/service-responses.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const named = (prefix: string) =>
  Object.entries(samples).filter(([name]) => name.startsWith(prefix));

test("health and preparation responses parse", () => {
  assert.equal(parseHealth(samples.health).worker_ready, true);
  assert.ok(parsePreparationItems(samples.prepare).length > 0);
  for (const [name, body] of named("status_")) {
    const [item] = parsePreparationItems(body);
    assert.equal(`status_${item.status}`, name);
  }
});

test("masters parse, including structured tracing warnings", () => {
  const masters = named("master_");
  assert.ok(masters.length >= 3);
  for (const [, body] of masters) {
    const master = parseMaster(body);
    assert.ok(master.vertex_count > 0 && master.aspect_ratio > 0);
    for (const warning of master.diagnostics.warnings) assert.ok(warning.code && warning.message);
  }
  const flower = parseMaster(samples.master_flower);
  assert.ok(flower.diagnostics.warnings.some((w) => w.code === "SMALL_OPENINGS_FILLED"));
});

test("batch drafts parse, including lines without a usable master", () => {
  assert.equal(parseBatchDraft(samples.batch_draft).status, "draft");
  const tooBig = parseBatchDraft(samples.batch_draft_invalid);
  assert.equal(tooBig.lines[0].errors[0].code, "PART_DOES_NOT_FIT");
  const unknown = parseBatchDraft(samples.batch_draft_unknown_master);
  assert.equal(unknown.status, "invalid");
  assert.equal(unknown.lines[0].actual_width_mm, null);
  assert.equal(unknown.lines[0].errors[0].code, "NOT_FOUND");
});

test("jobs parse in every terminal state", () => {
  const jobs = named("job_");
  assert.ok(jobs.length >= 4);
  for (const [name, body] of jobs) {
    const job = parseJob(body);
    assert.equal(`job_${job.kind}_`, name.slice(0, `job_${job.kind}_`.length));
  }
  assert.ok(parseJobs(samples.jobs).length > 0);
});

test("batches parse; only a completed batch exposes the ZIP", () => {
  const completed = parseBatch(samples.batch_completed);
  assert.equal(completed.status, "completed");
  assert.ok(completed.artifacts.zip);
  assert.equal(completed.totals?.unplaced, 0);
  assert.ok(completed.artifacts.sheets.every((sheet) => sheet.dxf && sheet.svg));

  const incomplete = parseBatch(samples.batch_incomplete);
  assert.equal(incomplete.artifacts.zip, null);
  assert.ok((incomplete.totals?.unplaced ?? 0) > 0);
  assert.ok(incomplete.artifacts.sheets.every((sheet) => sheet.dxf === null));

  const cancelled = parseBatch(samples.batch_cancelled);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.artifacts.zip, null);

  assert.ok(parseBatches(samples.batches).length > 0);
});

test("service error envelopes are recognised", () => {
  assert.equal(errorEnvelope(samples.error_not_found)?.code, "NOT_FOUND");
});
