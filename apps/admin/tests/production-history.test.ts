import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJob, parseJobs } from "../src/features/production/contracts.ts";
import { traceSubject } from "../src/features/production/history-logic.ts";

const base = {
  id: "job-old",
  kind: "trace",
  status: "failed",
  stage: "failed",
  progress: 0.05,
  heartbeat_at: null,
  attempts: 1,
  cache_hit: false,
  error: { code: "SOURCE_UNAVAILABLE", message: "The image host answered HTTP 404.", details: {} },
  result: null,
  created_at: "2026-10-27T00:10:00Z",
  updated_at: "2026-10-27T00:10:05Z",
};

const named = {
  ...base,
  product_id: "p1",
  product_name: "Leaf Four-Point Shuriken",
  product_slug: "leaf-four-point-shuriken",
  product_thumbnail_url: "https://convex.echoray.io/api/storage/thumb-1",
};

test("trace jobs carry the product snapshot the service recorded", () => {
  assert.deepEqual(parseJob(named).product, {
    id: "p1",
    name: "Leaf Four-Point Shuriken",
    slug: "leaf-four-point-shuriken",
    thumbnail: "https://convex.echoray.io/api/storage/thumb-1",
  });
  // Older services and nest jobs have no snapshot.
  assert.equal(parseJob(base).product, null);
  assert.equal(parseJob({ ...base, kind: "nest", product_id: null, product_name: null }).product, null);
  assert.equal(parseJobs({ items: [named, base] })[0]!.product?.name, "Leaf Four-Point Shuriken");
});

test("job product thumbnails must be web URLs and fields must be strings", () => {
  assert.equal(parseJob({ ...named, product_thumbnail_url: "javascript:alert(1)" }).product?.thumbnail, null);
  assert.equal(parseJob({ ...named, product_name: "  " }).product?.name, null);
  assert.throws(() => parseJob({ ...named, product_name: 7 }));
});

test("an older failure keeps its name after the product is traced again", () => {
  // This browser now only associates the product with the retry's job, and has since renamed it.
  const local = { id: "p1", name: "Leaf Shuriken (renamed)", thumbnail: "https://example.test/new.png" };
  const subject = traceSubject(parseJob(named), local);
  assert.equal(subject.source, "job");
  assert.equal(subject.name, "Leaf Four-Point Shuriken");
  assert.equal(subject.thumbnail, "https://convex.echoray.io/api/storage/thumb-1");
  assert.equal(subject.search, "Leaf Four-Point Shuriken");
});

test("history fills gaps in a snapshot from the same product only", () => {
  const noThumb = parseJob({ ...named, product_thumbnail_url: null });
  assert.equal(traceSubject(noThumb, { id: "p1", name: "Leaf", thumbnail: "https://t/1.png" }).thumbnail, "https://t/1.png");
  assert.equal(traceSubject(noThumb, { id: "p2", name: "Other", thumbnail: "https://t/2.png" }).thumbnail, null);
  const slugOnly = parseJob({ ...named, product_name: null });
  assert.equal(traceSubject(slugOnly, null).name, "leaf-four-point-shuriken");
});

test("jobs from before the snapshot fall back to this browser, then to nothing", () => {
  const old = parseJob(base);
  assert.deepEqual(traceSubject(old, { id: "p1", name: "Leaf", thumbnail: null }), {
    name: "Leaf",
    thumbnail: null,
    source: "browser",
    search: "Leaf",
  });
  assert.deepEqual(traceSubject(old, null), { name: null, thumbnail: null, source: "unknown", search: null });
});
