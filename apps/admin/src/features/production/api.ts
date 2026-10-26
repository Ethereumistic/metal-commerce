import { createServerFn } from "@tanstack/react-start";
import { LIMITS } from "./batch-logic";
import {
  IDEMPOTENCY_KEY,
  RESOURCE_ID,
  ROTATIONS,
  TIME_BUDGETS,
  type BatchLineRequest,
  type BatchRequest,
  type JobKind,
  type Rotation,
  type SizeMode,
  type TimeBudget,
} from "./contracts";

// Server functions for the Production workspace. They validate the browser's
// input, then hand over to lib/production.server.ts, which authorizes the
// operator and talks to the artwork service. Mutations carry an
// Idempotency-Key the browser creates once per operator action and reuses for
// retries, so an uncertain submission is never queued twice.

// Shared with the browser's own checks (batch-logic.ts), so the operator sees
// these limits at the row before a request is ever sent.
const { maxMm: MAX_MM, maxLines: MAX_LINES, maxQuantity: MAX_QUANTITY, maxSheets: MAX_SHEETS } = LIMITS;
const MAX_TOTAL_INSTANCES = LIMITS.maxTotalParts;
const SLUG = /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/;

function input(data: unknown) {
  return (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
}
function resourceId(value: unknown) {
  if (typeof value !== "string" || !RESOURCE_ID.test(value)) throw new Error("Invalid id");
  return value;
}
function idempotencyKey(value: unknown) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value))
    throw new Error("Invalid idempotency key");
  return value;
}
function productRef(value: unknown) {
  const ref = input(value);
  if (typeof ref.slug !== "string" || !SLUG.test(ref.slug)) throw new Error("Invalid product");
  return { id: resourceId(ref.id), slug: ref.slug };
}
// Messages name the field and the allowed range: the browser shows them as
// the reason a request was rejected.
function finite(value: unknown, min: number, max: number, what = "Value") {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${what} must be between ${min} and ${max}.`);
  return value;
}
function integer(value: unknown, min: number, max: number, what = "Value") {
  const result = finite(value, min, max, what);
  if (!Number.isInteger(result)) throw new Error(`${what} must be a whole number.`);
  return result;
}
function label(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new Error("Invalid text");
  return value.trim();
}
function positiveOrNull(value: unknown, what: string) {
  return value == null ? null : finite(value, 0.01, MAX_MM, what);
}

function batchLine(value: unknown, index: number): BatchLineRequest {
  const row = `Row ${index + 1}`;
  const line = input(value);
  const size = input(line.size);
  const mode = size.mode as SizeMode;
  if (!["width", "height", "fit"].includes(mode)) throw new Error("Invalid size mode");
  const width = positiveOrNull(size.width_mm, `${row} width (mm)`);
  const height = positiveOrNull(size.height_mm, `${row} height (mm)`);
  if ((mode !== "height" && width == null) || (mode !== "width" && height == null))
    throw new Error("Missing dimensions");
  const rotations = Array.isArray(line.allowed_rotations) ? line.allowed_rotations : [];
  if (
    !rotations.length ||
    new Set(rotations).size !== rotations.length ||
    !rotations.every((rotation) => ROTATIONS.includes(rotation as Rotation))
  )
    throw new Error("Invalid rotations");
  return {
    line_id: resourceId(line.line_id),
    product_id: resourceId(line.product_id),
    master_id: resourceId(line.master_id),
    size: {
      mode,
      width_mm: mode === "height" ? null : width,
      height_mm: mode === "width" ? null : height,
    },
    quantity: integer(line.quantity, 1, MAX_QUANTITY, `${row} quantity`),
    material: label(line.material, 80),
    thickness_mm: finite(line.thickness_mm, 0.1, 100, `${row} thickness (mm)`),
    allowed_rotations: (rotations as Rotation[]).slice().sort((a, b) => a - b),
    variant_id: line.variant_id == null ? null : label(line.variant_id, 80),
  };
}

export function parseBatchRequest(value: unknown): BatchRequest {
  const body = input(value);
  const lines = Array.isArray(body.lines) ? body.lines.map(batchLine) : [];
  if (!lines.length || lines.length > MAX_LINES) throw new Error(`A batch needs 1 to ${MAX_LINES} rows.`);
  if (new Set(lines.map((line) => line.line_id)).size !== lines.length)
    throw new Error("Duplicate line ids");
  if (lines.reduce((sum, line) => sum + line.quantity, 0) > MAX_TOTAL_INSTANCES)
    throw new Error(`A batch holds at most ${MAX_TOTAL_INSTANCES} parts.`);
  const stock = input(body.stock);
  const margins = input(stock.margins_mm);
  const optimization = input(body.optimization);
  const budget = optimization.time_budget_s as TimeBudget;
  if (!TIME_BUDGETS.includes(budget)) throw new Error("Invalid time budget");
  return {
    name: body.name == null || body.name === "" ? null : label(body.name, 120),
    lines,
    stock: {
      width_mm: finite(stock.width_mm, 1, MAX_MM),
      height_mm: finite(stock.height_mm, 1, MAX_MM),
      margins_mm: {
        left: finite(margins.left, 0, MAX_MM),
        right: finite(margins.right, 0, MAX_MM),
        bottom: finite(margins.bottom, 0, MAX_MM),
        top: finite(margins.top, 0, MAX_MM),
      },
      gap_mm: finite(stock.gap_mm, 0, 1_000),
      max_sheets: integer(stock.max_sheets, 1, MAX_SHEETS, "Maximum sheets"),
      label: label(stock.label, 120),
    },
    optimization: {
      time_budget_s: budget,
      seed: integer(optimization.seed, 0, 2 ** 31 - 1),
    },
    export: { chord_tolerance_mm: 0.05 },
  };
}

function search(value: unknown) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid search");
  const trimmed = value.trim();
  // core's catalog search limits.
  if (trimmed.length > 200 || trimmed.split(/\s+/).length > 16) throw new Error("Search is too long");
  return trimmed || undefined;
}

const server = () => import("@/lib/production.server");

export const getHealth = createServerFn({ method: "GET" }).handler(async () =>
  (await server()).health(),
);

export const listProducts = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const values = input(data);
    const cursor = values.cursor;
    if (cursor != null && (typeof cursor !== "string" || cursor.length > 200))
      throw new Error("Invalid cursor");
    return { cursor: (cursor as string | null) ?? undefined, search: search(values.search) };
  })
  .handler(async ({ data }) => (await server()).catalogPage(data));

export const getProduct = createServerFn({ method: "GET" })
  .validator(productRef)
  .handler(async ({ data }) => (await server()).catalogDetail(data));

export const prepareProducts = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const values = input(data);
    const products = Array.isArray(values.products) ? values.products.map(productRef) : [];
    if (!products.length || products.length > 50) throw new Error("Prepare 1 to 50 products at a time");
    if (new Set(products.map((product) => product.id)).size !== products.length)
      throw new Error("Duplicate products");
    return {
      products,
      reprocess: values.reprocess === true,
      idempotencyKey: idempotencyKey(values.idempotencyKey),
    };
  })
  .handler(async ({ data }) => (await server()).prepare(data));

export const getMaster = createServerFn({ method: "GET" })
  .validator((data: unknown) => resourceId(input(data).id))
  .handler(async ({ data }) => (await server()).master(data));

export const createBatch = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const values = input(data);
    return {
      request: parseBatchRequest(values.request),
      idempotencyKey: idempotencyKey(values.idempotencyKey),
    };
  })
  .handler(async ({ data }) => (await server()).createBatch(data));

export const startNesting = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const values = input(data);
    return {
      batchId: resourceId(values.batchId),
      idempotencyKey: idempotencyKey(values.idempotencyKey),
    };
  })
  .handler(async ({ data }) => (await server()).nest(data));

export const getJob = createServerFn({ method: "GET" })
  .validator((data: unknown) => resourceId(input(data).id))
  .handler(async ({ data }) => (await server()).job(data));

export const getJobs = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const ids = input(data).ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new Error("Invalid job ids");
    return [...new Set(ids.map(resourceId))];
  })
  .handler(async ({ data }) => (await server()).jobsById(data));

export const listJobs = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const values = input(data);
    const kind = values.kind as JobKind | undefined;
    if (kind != null && kind !== "trace" && kind !== "nest") throw new Error("Invalid kind");
    return { kind, limit: values.limit == null ? 25 : integer(values.limit, 1, 200) };
  })
  .handler(async ({ data }) => (await server()).jobHistory(data));

export const cancelJob = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const values = input(data);
    return { id: resourceId(values.id), idempotencyKey: idempotencyKey(values.idempotencyKey) };
  })
  .handler(async ({ data }) => (await server()).cancelJob(data));

export const getBatch = createServerFn({ method: "GET" })
  .validator((data: unknown) => resourceId(input(data).id))
  .handler(async ({ data }) => (await server()).batch(data));

export const listBatches = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const limit = input(data).limit;
    return limit == null ? 25 : integer(limit, 1, 200);
  })
  .handler(async ({ data }) => (await server()).batchHistory(data));

/** Same-origin download URL for an artifact (the server route checks the session). */
export function artifactUrl(id: string) {
  return `/api/production/artifacts/${encodeURIComponent(id)}`;
}

/** A fresh key for one operator action; keep it for that action's retries. */
export function newIdempotencyKey() {
  return crypto.randomUUID();
}
