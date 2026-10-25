// Types and runtime validation for the local artwork service's v1 HTTP API
// (services/artwork-service/CONTRACT.md). The admin server validates every
// service response with these parsers before it reaches the browser, so a
// mismatched or partial reply fails loudly instead of rendering wrong numbers.
//
// No runtime imports: this module is shared by the server, the browser and
// Node's test runner.

export const PREPARATION_STATUSES = [
  "unprepared",
  "queued",
  "processing",
  "ready",
  "failed",
  "stale",
] as const;
export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobKind = "trace" | "nest";

export const BATCH_STATUSES = [
  "draft",
  "invalid",
  "queued",
  "nesting",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];
export const TIME_BUDGETS = [10, 30, 120] as const;
export type TimeBudget = (typeof TIME_BUDGETS)[number];
export type SizeMode = "width" | "height" | "fit";

/** Any JSON value. Free-form service fields keep this type so they stay serializable. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ServiceError = {
  code: string;
  message: string;
  details?: JsonObject;
};

/** What every admin production call returns. `offline` means the service could not be reached. */
export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; offline: true }
  | { ok: false; offline: false; error: ServiceError };

export type Health = {
  service_version: string;
  worker_ready: boolean;
  queue: { queued: number; running: number };
  tracer_version: string;
  solver_version: string;
  exporter_version: string;
};

export type SourceSnapshot = {
  gallery_index: 0;
  source_identity: string;
  source_version: string | null;
  original_url: string;
  width: number | null;
  height: number | null;
};

export type PrepareRequest = {
  products: {
    product_id: string;
    product_revision: number;
    name: string;
    slug: string;
    source: SourceSnapshot | null;
  }[];
  reprocess: boolean;
};

export type StatusRequest = {
  products: {
    product_id: string;
    source_identity: string;
    source_version: string | null;
  }[];
};

export type PreparationItem = {
  product_id: string;
  status: PreparationStatus;
  master_id: string | null;
  job_id: string | null;
  error: ServiceError | null;
};

export type Master = {
  id: string;
  product_id: string;
  revision: number;
  source: JsonObject;
  aspect_ratio: number;
  normalized_bounds: JsonValue;
  components: number;
  holes: number;
  vertex_count: number;
  trace_engine: string;
  trace_version: string;
  trace_settings: JsonValue;
  diagnostics: {
    threshold: number | null;
    candidates: JsonValue;
    noise_removed_area_px: number | null;
    warnings: { code: string; message: string }[];
  };
  artifacts: {
    overlay_png: string | null;
    solid_png: string | null;
    master_json: string | null;
    master_svg: string | null;
  };
  created_at: string;
};

export type BatchLineRequest = {
  line_id: string;
  product_id: string;
  master_id: string;
  size: { mode: SizeMode; width_mm: number | null; height_mm: number | null };
  quantity: number;
  material: string;
  thickness_mm: number;
  allowed_rotations: Rotation[];
  variant_id: string | null;
};

export type StockRequest = {
  width_mm: number;
  height_mm: number;
  margins_mm: { left: number; right: number; bottom: number; top: number };
  gap_mm: number;
  max_sheets: number;
  label: string;
};

export type BatchRequest = {
  name: string | null;
  lines: BatchLineRequest[];
  stock: StockRequest;
  optimization: { time_budget_s: TimeBudget; seed: number };
  export: { chord_tolerance_mm: number };
};

export type BatchGroup = {
  group_key: string;
  material: string;
  thickness_mm: number;
  line_ids: string[];
  instance_count: number;
};

export type BatchDraft = {
  batch_id: string;
  status: "draft" | "invalid";
  lines: {
    line_id: string;
    // Null when the line has no usable master (unknown or foreign master id).
    actual_width_mm: number | null;
    actual_height_mm: number | null;
    fits: boolean;
    errors: ServiceError[];
  }[];
  groups: BatchGroup[];
};

export type Job = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  stage: string | null;
  progress: number;
  heartbeat_at: string | null;
  attempts: number;
  cache_hit: boolean;
  error: ServiceError | null;
  result: { master_id?: string; batch_id?: string } | null;
  created_at: string;
  updated_at: string;
};

export type Placement = {
  instance_id: string;
  line_id: string;
  product_id: string;
  rotation_deg: number;
  tx_mm: number;
  ty_mm: number;
};

export type Sheet = {
  sheet_id: string;
  group_key: string;
  index: number;
  width_mm: number;
  height_mm: number;
  placements: Placement[];
  metrics: JsonObject;
};

export type BatchTotals = {
  requested: number;
  placed: number;
  unplaced: number;
  sheet_count: number;
  metal_area_mm2: number;
  sheet_area_mm2: number;
  utilization: number;
  occupied_extent_mm: JsonValue;
  runtime_s: number | null;
  optimization_status: string | null;
};

export type Batch = {
  batch_id: string;
  status: BatchStatus;
  request: JsonObject;
  groups: BatchGroup[];
  sheets: Sheet[];
  totals: BatchTotals | null;
  validation: JsonValue;
  artifacts: {
    zip: string | null;
    manifest: string | null;
    sheets: { sheet_id: string; dxf: string | null; svg: string | null }[];
  };
};

/** Summary row for history lists; the service may return more fields. */
export type BatchSummary = {
  batch_id: string;
  status: BatchStatus;
  name: string | null;
  created_at: string | null;
  totals: BatchTotals | null;
};

export class ContractError extends Error {
  readonly path: string;
  constructor(path: string, expected: string) {
    super(`Unexpected artwork service response at ${path}: expected ${expected}`);
    this.path = path;
  }
}

// Bodies come from response.json(), so any nested value is already JSON.
const json = (value: unknown) => (value ?? null) as JsonValue;

function record(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError(path, "an object");
  return value as JsonObject;
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ContractError(path, "an array");
  return value;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ContractError(path, "a string");
  return value;
}
function id(value: unknown, path: string): string {
  const result = text(value, path);
  if (!result) throw new ContractError(path, "a non-empty id");
  return result;
}
function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ContractError(path, "a finite number");
  return value;
}
function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractError(path, "a boolean");
  return value;
}
function nullable<T>(
  parse: (value: unknown, path: string) => T,
): (value: unknown, path: string) => T | null {
  return (value, path) => (value == null ? null : parse(value, path));
}
function oneOf<T extends string>(options: readonly T[]) {
  return (value: unknown, path: string): T => {
    if (!options.includes(value as T))
      throw new ContractError(path, options.join(" | "));
    return value as T;
  };
}

export function parseServiceError(value: unknown, path = "error"): ServiceError {
  const error = record(value, path);
  return {
    code: text(error.code, `${path}.code`),
    message: text(error.message ?? "", `${path}.message`),
    ...(error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? { details: error.details }
      : {}),
  };
}

/** Reads the service's `{error: {...}}` envelope, or null when the body is not one. */
export function errorEnvelope(value: unknown): ServiceError | null {
  try {
    return parseServiceError(record(value, "body").error);
  } catch {
    return null;
  }
}

export function parseHealth(value: unknown): Health {
  const body = record(value, "health");
  const queue = record(body.queue, "health.queue");
  return {
    service_version: text(body.service_version, "health.service_version"),
    worker_ready: flag(body.worker_ready, "health.worker_ready"),
    queue: {
      queued: number(queue.queued, "health.queue.queued"),
      running: number(queue.running, "health.queue.running"),
    },
    tracer_version: text(body.tracer_version, "health.tracer_version"),
    solver_version: text(body.solver_version, "health.solver_version"),
    exporter_version: text(body.exporter_version, "health.exporter_version"),
  };
}

function parsePreparationItem(value: unknown, path: string): PreparationItem {
  const item = record(value, path);
  return {
    product_id: id(item.product_id, `${path}.product_id`),
    status: oneOf(PREPARATION_STATUSES)(item.status, `${path}.status`),
    master_id: nullable(id)(item.master_id, `${path}.master_id`),
    job_id: nullable(id)(item.job_id, `${path}.job_id`),
    error: nullable(parseServiceError)(item.error, `${path}.error`),
  };
}

/** Shared by POST /v1/prepare and POST /v1/products/status. */
export function parsePreparationItems(value: unknown): PreparationItem[] {
  const body = record(value, "body");
  return list(body.items, "items").map((item, index) =>
    parsePreparationItem(item, `items[${index}]`),
  );
}

export function parseMaster(value: unknown): Master {
  const body = record(value, "master");
  const diagnostics = record(body.diagnostics ?? {}, "master.diagnostics");
  const artifacts = record(body.artifacts, "master.artifacts");
  const artifact = (key: string) =>
    nullable(id)(artifacts[key], `master.artifacts.${key}`);
  const aspect = number(body.aspect_ratio, "master.aspect_ratio");
  if (aspect <= 0) throw new ContractError("master.aspect_ratio", "a positive ratio");
  return {
    id: id(body.id, "master.id"),
    product_id: id(body.product_id, "master.product_id"),
    revision: number(body.revision, "master.revision"),
    source: record(body.source, "master.source"),
    aspect_ratio: aspect,
    normalized_bounds: json(body.normalized_bounds),
    components: number(body.components, "master.components"),
    holes: number(body.holes, "master.holes"),
    vertex_count: number(body.vertex_count, "master.vertex_count"),
    trace_engine: text(body.trace_engine, "master.trace_engine"),
    trace_version: text(body.trace_version, "master.trace_version"),
    trace_settings: json(body.trace_settings),
    diagnostics: {
      threshold: nullable(number)(diagnostics.threshold, "master.diagnostics.threshold"),
      candidates: json(diagnostics.candidates),
      noise_removed_area_px: nullable(number)(
        diagnostics.noise_removed_area_px,
        "master.diagnostics.noise_removed_area_px",
      ),
      warnings: list(diagnostics.warnings ?? [], "master.diagnostics.warnings").map(
        (raw, index) => {
          const { code, message } = parseServiceError(raw, `master.diagnostics.warnings[${index}]`);
          return { code, message };
        },
      ),
    },
    artifacts: {
      overlay_png: artifact("overlay_png"),
      solid_png: artifact("solid_png"),
      master_json: artifact("master_json"),
      master_svg: artifact("master_svg"),
    },
    created_at: text(body.created_at, "master.created_at"),
  };
}

function parseGroup(value: unknown, path: string): BatchGroup {
  const group = record(value, path);
  return {
    group_key: id(group.group_key, `${path}.group_key`),
    material: text(group.material, `${path}.material`),
    thickness_mm: number(group.thickness_mm, `${path}.thickness_mm`),
    line_ids: list(group.line_ids, `${path}.line_ids`).map((line, index) =>
      id(line, `${path}.line_ids[${index}]`),
    ),
    instance_count: number(group.instance_count, `${path}.instance_count`),
  };
}

export function parseBatchDraft(value: unknown): BatchDraft {
  const body = record(value, "batch");
  return {
    batch_id: id(body.batch_id, "batch.batch_id"),
    status: oneOf(["draft", "invalid"] as const)(body.status, "batch.status"),
    lines: list(body.lines, "batch.lines").map((raw, index) => {
      const path = `batch.lines[${index}]`;
      const line = record(raw, path);
      return {
        line_id: id(line.line_id, `${path}.line_id`),
        actual_width_mm: nullable(number)(line.actual_width_mm, `${path}.actual_width_mm`),
        actual_height_mm: nullable(number)(line.actual_height_mm, `${path}.actual_height_mm`),
        fits: flag(line.fits, `${path}.fits`),
        errors: list(line.errors ?? [], `${path}.errors`).map((error, i) =>
          parseServiceError(error, `${path}.errors[${i}]`),
        ),
      };
    }),
    groups: list(body.groups, "batch.groups").map((group, index) =>
      parseGroup(group, `batch.groups[${index}]`),
    ),
  };
}

export function parseJobStart(value: unknown): { job_id: string } {
  return { job_id: id(record(value, "body").job_id, "job_id") };
}

export function parseJob(value: unknown, path = "job"): Job {
  const job = record(value, path);
  const progress = number(job.progress, `${path}.progress`);
  if (progress < 0 || progress > 1)
    throw new ContractError(`${path}.progress`, "a value from 0 to 1");
  const result = nullable(record)(job.result, `${path}.result`);
  return {
    id: id(job.id, `${path}.id`),
    kind: oneOf(["trace", "nest"] as const)(job.kind, `${path}.kind`),
    status: oneOf(JOB_STATUSES)(job.status, `${path}.status`),
    stage: nullable(text)(job.stage, `${path}.stage`),
    progress,
    heartbeat_at: nullable(text)(job.heartbeat_at, `${path}.heartbeat_at`),
    attempts: number(job.attempts, `${path}.attempts`),
    cache_hit: flag(job.cache_hit ?? false, `${path}.cache_hit`),
    error: nullable(parseServiceError)(job.error, `${path}.error`),
    result: result && {
      ...(result.master_id != null
        ? { master_id: id(result.master_id, `${path}.result.master_id`) }
        : {}),
      ...(result.batch_id != null
        ? { batch_id: id(result.batch_id, `${path}.result.batch_id`) }
        : {}),
    },
    created_at: text(job.created_at, `${path}.created_at`),
    updated_at: text(job.updated_at, `${path}.updated_at`),
  };
}

/** GET /v1/jobs answers either a bare array or `{items}` / `{jobs}`; accept all three. */
function rows(value: unknown, keys: string[], path: string): unknown[] {
  if (Array.isArray(value)) return value;
  const body = record(value, path);
  for (const key of keys) if (Array.isArray(body[key])) return body[key] as unknown[];
  throw new ContractError(path, `an array or {${keys.join("|")}}`);
}

export function parseJobs(value: unknown): Job[] {
  return rows(value, ["items", "jobs"], "jobs").map((job, index) =>
    parseJob(job, `jobs[${index}]`),
  );
}

function parseTotals(value: unknown, path: string): BatchTotals {
  const totals = record(value, path);
  return {
    requested: number(totals.requested, `${path}.requested`),
    placed: number(totals.placed, `${path}.placed`),
    unplaced: number(totals.unplaced, `${path}.unplaced`),
    sheet_count: number(totals.sheet_count, `${path}.sheet_count`),
    metal_area_mm2: number(totals.metal_area_mm2, `${path}.metal_area_mm2`),
    sheet_area_mm2: number(totals.sheet_area_mm2, `${path}.sheet_area_mm2`),
    utilization: number(totals.utilization, `${path}.utilization`),
    occupied_extent_mm: json(totals.occupied_extent_mm),
    runtime_s: nullable(number)(totals.runtime_s, `${path}.runtime_s`),
    optimization_status: nullable(text)(
      totals.optimization_status,
      `${path}.optimization_status`,
    ),
  };
}

function parseSheet(value: unknown, path: string): Sheet {
  const sheet = record(value, path);
  return {
    sheet_id: id(sheet.sheet_id, `${path}.sheet_id`),
    group_key: text(sheet.group_key, `${path}.group_key`),
    index: number(sheet.index, `${path}.index`),
    width_mm: number(sheet.width_mm, `${path}.width_mm`),
    height_mm: number(sheet.height_mm, `${path}.height_mm`),
    placements: list(sheet.placements, `${path}.placements`).map((raw, index) => {
      const at = `${path}.placements[${index}]`;
      const placement = record(raw, at);
      return {
        instance_id: id(placement.instance_id, `${at}.instance_id`),
        line_id: id(placement.line_id, `${at}.line_id`),
        product_id: id(placement.product_id, `${at}.product_id`),
        rotation_deg: number(placement.rotation_deg, `${at}.rotation_deg`),
        tx_mm: number(placement.tx_mm, `${at}.tx_mm`),
        ty_mm: number(placement.ty_mm, `${at}.ty_mm`),
      };
    }),
    metrics: record(sheet.metrics ?? {}, `${path}.metrics`),
  };
}

export function parseBatch(value: unknown): Batch {
  const body = record(value, "batch");
  const status = oneOf(BATCH_STATUSES)(body.status, "batch.status");
  const artifacts = record(body.artifacts ?? {}, "batch.artifacts");
  const zip = nullable(id)(artifacts.zip, "batch.artifacts.zip");
  return {
    batch_id: id(body.batch_id, "batch.batch_id"),
    status,
    request: record(body.request ?? {}, "batch.request"),
    groups: list(body.groups ?? [], "batch.groups").map((group, index) =>
      parseGroup(group, `batch.groups[${index}]`),
    ),
    sheets: list(body.sheets ?? [], "batch.sheets").map((sheet, index) =>
      parseSheet(sheet, `batch.sheets[${index}]`),
    ),
    totals: nullable(parseTotals)(body.totals, "batch.totals"),
    validation: json(body.validation),
    artifacts: {
      // A complete package only exists for a completed batch; never surface
      // a ZIP for partial output even if one is listed.
      zip: status === "completed" ? zip : null,
      manifest: nullable(id)(artifacts.manifest, "batch.artifacts.manifest"),
      sheets: list(artifacts.sheets ?? [], "batch.artifacts.sheets").map(
        (raw, index) => {
          const path = `batch.artifacts.sheets[${index}]`;
          const entry = record(raw, path);
          return {
            sheet_id: id(entry.sheet_id, `${path}.sheet_id`),
            dxf: nullable(id)(entry.dxf, `${path}.dxf`),
            svg: nullable(id)(entry.svg, `${path}.svg`),
          };
        },
      ),
    },
  };
}

export function parseBatches(value: unknown): BatchSummary[] {
  return rows(value, ["items", "batches"], "batches").map((raw, index) => {
    const path = `batches[${index}]`;
    const batch = record(raw, path);
    const request =
      batch.request && typeof batch.request === "object" && !Array.isArray(batch.request)
        ? batch.request
        : ({} as JsonObject);
    return {
      batch_id: id(batch.batch_id, `${path}.batch_id`),
      status: oneOf(BATCH_STATUSES)(batch.status, `${path}.status`),
      name: nullable(text)(batch.name ?? request.name, `${path}.name`),
      created_at: nullable(text)(batch.created_at, `${path}.created_at`),
      totals: nullable(parseTotals)(batch.totals, `${path}.totals`),
    };
  });
}

/** Path-safe identifiers for service resources (jobs, batches, masters, artifacts). */
export const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Client-generated idempotency keys (UUIDs, or similar opaque tokens). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

// Admin-side catalog DTOs (Echoray catalog, resolved by the admin server).

export type FirstImageError = {
  code: "NO_FIRST_IMAGE" | "SOURCE_UNAVAILABLE";
  message: string;
};

export type CatalogCard = {
  id: string;
  slug: string;
  name: string;
  revision: number;
  published: boolean;
  archived: boolean;
  /** Display-size rendition of gallery entry zero; never another entry. */
  thumbnail: string | null;
  /** Identity of gallery entry zero, or why it cannot be used. */
  firstImage:
    | { ok: true; sourceIdentity: string; width: number | null; height: number | null }
    | { ok: false; error: FirstImageError };
  variants: { key: string; label: string; active: boolean }[];
  dimensions: { id: string; name: string; unit: string | null }[];
  /** Preparation state from the service; null when the service could not be asked. */
  preparation: PreparationItem | null;
};

export type CatalogPage = {
  items: CatalogCard[];
  cursor: string | null;
  /** "all" pages the whole catalog by slug; "search" is the best name matches only (core returns no cursor for searches). */
  scope: "all" | "search";
  /** True when preparation statuses are missing because the service was unreachable. */
  statusOffline: boolean;
};
