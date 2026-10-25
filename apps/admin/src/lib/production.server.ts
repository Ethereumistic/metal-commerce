import { env } from "cloudflare:workers";
import type { ConvexHttpClient } from "convex/browser";
import type { AdminSession } from "./auth";
import { AuthError, operatorClient } from "./auth.server";
import {
  CatalogError,
  catalogProduct,
  listCatalog,
  resolveFirstImage,
  toCard,
  type CatalogProduct,
} from "./production-catalog.server";
import {
  ContractError,
  errorEnvelope,
  parseBatch,
  parseBatchDraft,
  parseBatches,
  parseHealth,
  parseJob,
  parseJobStart,
  parseJobs,
  parseMaster,
  parsePreparationItems,
  type BatchRequest,
  type CatalogCard,
  type CatalogPage,
  type Job,
  type JobKind,
  type PrepareRequest,
  type PreparationItem,
  type ServiceError,
  type ServiceResult,
} from "../features/production/contracts";

// Server-side proxy from Metal Admin to the local artwork service on Omarchy
// (directly on loopback in development, through a Cloudflare Access protected
// tunnel when hosted). Every call re-checks the operator's membership; the
// business, actor and edit right come from the session, never the browser.
// Service credentials stay in Worker bindings and are never logged.

type Operator = { session: AdminSession; userId: string; convex: ConvexHttpClient };

const TIMEOUT_MS = 15_000;
const ARTIFACT_TIMEOUT_MS = 60_000;
// Cloudflare answers these when the tunnel or origin is down (530: tunnel not connected).
const UNREACHABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

const OFFLINE = { ok: false, offline: true } as const;

function fail(code: string, message: string): ServiceResult<never> {
  return { ok: false, offline: false, error: { code, message } };
}

type ServiceConfig = {
  origin: string;
  token: string;
  access: { id: string; secret: string } | null;
};

function serviceConfig(): ServiceConfig | ServiceResult<never> {
  const values = env as unknown as Record<string, unknown>;
  const read = (key: string) => {
    const value = values[key];
    return typeof value === "string" && value ? value : undefined;
  };
  if (read("ARTWORK_PRODUCTION_ENABLED") !== "true")
    return fail(
      "PRODUCTION_DISABLED",
      "Production processing is not enabled for this admin (ARTWORK_PRODUCTION_ENABLED).",
    );
  const origin = read("ARTWORK_SERVICE_ORIGIN");
  const token = read("ARTWORK_SERVICE_TOKEN");
  const accessId = read("ARTWORK_ACCESS_CLIENT_ID");
  const accessSecret = read("ARTWORK_ACCESS_CLIENT_SECRET");
  let url: URL | null = null;
  try {
    url = origin ? new URL(origin) : null;
  } catch {
    url = null;
  }
  const secure =
    url?.protocol === "https:" ||
    (url?.protocol === "http:" && LOOPBACK.test(url.hostname));
  if (!url || !secure || !token || !!accessId !== !!accessSecret)
    return fail(
      "PRODUCTION_MISCONFIGURED",
      "The artwork service origin or credentials are not configured correctly.",
    );
  return {
    origin: url.origin,
    token,
    access: accessId && accessSecret ? { id: accessId, secret: accessSecret } : null,
  };
}

function isFailure(value: unknown): value is ServiceResult<never> {
  return !!value && typeof value === "object" && "ok" in value;
}

/** The signed-in operator, refused unless a member (and an editor when `edit`). */
async function authorize(edit: boolean): Promise<Operator | ServiceResult<never>> {
  let operator: Awaited<ReturnType<typeof operatorClient>>;
  try {
    operator = await operatorClient();
  } catch (error) {
    if (error instanceof AuthError)
      return fail("AUTH_UNAVAILABLE", "Echoray sign-in is unreachable. Try again shortly.");
    throw error;
  }
  if (!operator) return fail("UNAUTHORIZED", "Sign in again to continue.");
  // The service records the acting user on every job and batch.
  if (!operator.userId)
    return fail("UNAUTHORIZED", "Your Echoray account could not be identified. Sign in again.");
  if (edit && !operator.session.business.canEdit)
    return fail("FORBIDDEN", "Your role in this business cannot run production jobs.");
  return { ...operator, userId: operator.userId };
}

function headers(config: ServiceConfig, operator: Operator, idempotencyKey?: string) {
  const result = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.token}`,
    "X-Artwork-Business-Id": operator.session.business.id,
    "X-Artwork-Actor": operator.userId,
    "X-Artwork-Can-Edit": String(operator.session.business.canEdit),
  });
  if (idempotencyKey) result.set("Idempotency-Key", idempotencyKey);
  if (config.access) {
    result.set("CF-Access-Client-Id", config.access.id);
    result.set("CF-Access-Client-Secret", config.access.secret);
  }
  return result;
}

function logFailure(route: string, detail: Record<string, unknown>) {
  console.warn(JSON.stringify({ event: "metal_admin_artwork_service_failed", route, ...detail }));
}

/** Sends one request; `route` is a fixed label for logs (never the URL with ids or query). */
async function send(
  operator: Operator,
  route: string,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<Response | ServiceResult<never>> {
  const config = serviceConfig();
  if (isFailure(config)) return config;
  const init: RequestInit = {
    method,
    headers: headers(config, operator, options.idempotencyKey),
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  };
  if (options.body !== undefined) {
    (init.headers as Headers).set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  try {
    return await fetch(`${config.origin}${path}`, init);
  } catch (error) {
    logFailure(route, { reason: error instanceof Error ? error.name : "network" });
    return OFFLINE;
  }
}

async function call<T>(
  operator: Operator,
  route: string,
  method: "GET" | "POST",
  path: string,
  parse: (value: unknown) => T,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<ServiceResult<T>> {
  const response = await send(operator, route, method, path, options);
  if (isFailure(response)) return response;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status >= 300 && response.status < 400) {
    // Access answers an invalid service token with a login redirect.
    logFailure(route, { status: response.status });
    return fail("SERVICE_AUTH", "The processing tunnel refused the admin's access credentials.");
  }
  if (!response.ok) {
    const envelope = errorEnvelope(body);
    if (!envelope && UNREACHABLE.has(response.status)) {
      logFailure(route, { status: response.status });
      return OFFLINE;
    }
    logFailure(route, { status: response.status, code: envelope?.code ?? null });
    return {
      ok: false,
      offline: false,
      error: envelope ?? {
        code: "SERVICE_ERROR",
        message: `The processing service answered with status ${response.status}.`,
      },
    };
  }
  try {
    return { ok: true, data: parse(body) };
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    logFailure(route, { status: response.status, contract: error.path });
    return fail("INVALID_RESPONSE", error.message);
  }
}

function catalogFailure(error: unknown): ServiceResult<never> {
  if (!(error instanceof CatalogError)) throw error;
  if (error.code === "CATALOG_FORBIDDEN")
    return fail("FORBIDDEN", "Your Echoray role cannot read the catalog.");
  return fail("CATALOG_UNAVAILABLE", "The Echoray catalog could not be read. Try again shortly.");
}

const serverKey = () => crypto.randomUUID();

export async function health() {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  return call(operator, "health", "GET", "/v1/health", parseHealth);
}

/** Asks the service for each card's preparation state; cards keep `null` when it cannot answer. */
async function withStatuses(operator: Operator, cards: CatalogCard[]) {
  const known = cards.flatMap((card) =>
    card.firstImage.ok
      ? [{ product_id: card.id, source_identity: card.firstImage.sourceIdentity, source_version: null }]
      : [],
  );
  if (!known.length) return { cards, offline: false };
  // Status checks may mark masters stale; each check is its own request.
  const result = await call(operator, "products.status", "POST", "/v1/products/status", parsePreparationItems, {
    body: { products: known },
    idempotencyKey: serverKey(),
  });
  if (!result.ok) return { cards, offline: true };
  const byId = new Map(result.data.map((item) => [item.product_id, item]));
  return {
    cards: cards.map((card) => ({ ...card, preparation: byId.get(card.id) ?? null })),
    offline: false,
  };
}

export async function catalogPage(input: {
  cursor?: string;
  search?: string;
}): Promise<ServiceResult<CatalogPage>> {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  let page: Awaited<ReturnType<typeof listCatalog>>;
  try {
    page = await listCatalog(operator.convex, operator.session.business.id, input);
  } catch (error) {
    return catalogFailure(error);
  }
  const { cards, offline } = await withStatuses(operator, page.products.map(toCard));
  return {
    ok: true,
    data: { items: cards, cursor: page.cursor, scope: page.scope, statusOffline: offline },
  };
}

export async function catalogDetail(ref: { id: string; slug: string }): Promise<ServiceResult<CatalogCard>> {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  let product: CatalogProduct | null;
  try {
    product = await catalogProduct(operator.convex, operator.session.business.id, ref);
  } catch (error) {
    return catalogFailure(error);
  }
  if (!product) return fail("NOT_FOUND", "The product no longer exists or its route changed.");
  const { cards } = await withStatuses(operator, [toCard(product)]);
  return { ok: true, data: cards[0]! };
}

function localFailure(productId: string, code: string, message: string): PreparationItem {
  return { product_id: productId, status: "failed", master_id: null, job_id: null, error: { code, message } };
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size)
    results.push(...(await Promise.all(items.slice(start, start + size).map(work))));
  return results;
}

/**
 * Resolves each product's first image on the server (from the current
 * catalog, not the browser's card) and submits the snapshots for tracing.
 */
export async function prepare(input: {
  products: { id: string; slug: string }[];
  reprocess: boolean;
  idempotencyKey: string;
}): Promise<ServiceResult<{ items: PreparationItem[] }>> {
  const operator = await authorize(true);
  if (isFailure(operator)) return operator;
  let resolved: { ref: { id: string; slug: string }; product: CatalogProduct | null }[];
  try {
    resolved = await inBatches(input.products, 8, async (ref) => ({
      ref,
      product: await catalogProduct(operator.convex, operator.session.business.id, ref),
    }));
  } catch (error) {
    return catalogFailure(error);
  }
  const local = new Map<string, PreparationItem>();
  const request: PrepareRequest = { products: [], reprocess: input.reprocess };
  for (const { ref, product } of resolved) {
    if (!product) {
      local.set(ref.id, localFailure(ref.id, "NOT_FOUND", "The product no longer exists or its route changed."));
      continue;
    }
    const first = resolveFirstImage(product);
    if (!first.ok && first.error.code !== "NO_FIRST_IMAGE") {
      local.set(ref.id, localFailure(ref.id, first.error.code, first.error.message));
      continue;
    }
    // A product without images is still sent so the service records NO_FIRST_IMAGE.
    request.products.push({
      product_id: product.id,
      product_revision: product.revision,
      name: product.name,
      slug: product.slug,
      source: first.ok ? first.source : null,
    });
  }
  let remote: PreparationItem[] = [];
  if (request.products.length) {
    const result = await call(operator, "prepare", "POST", "/v1/prepare", parsePreparationItems, {
      body: request,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) return result;
    remote = result.data;
  }
  const byId = new Map(remote.map((item) => [item.product_id, item]));
  return {
    ok: true,
    data: {
      items: input.products.flatMap((ref) => {
        const item = local.get(ref.id) ?? byId.get(ref.id);
        return item ? [item] : [];
      }),
    },
  };
}

export async function master(id: string) {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  return call(operator, "masters.get", "GET", `/v1/masters/${id}`, parseMaster);
}

export async function createBatch(input: { request: BatchRequest; idempotencyKey: string }) {
  const operator = await authorize(true);
  if (isFailure(operator)) return operator;
  return call(operator, "batches.create", "POST", "/v1/batches", parseBatchDraft, {
    body: input.request,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function nest(input: { batchId: string; idempotencyKey: string }) {
  const operator = await authorize(true);
  if (isFailure(operator)) return operator;
  return call(operator, "batches.nest", "POST", `/v1/batches/${input.batchId}/nest`, parseJobStart, {
    body: {},
    idempotencyKey: input.idempotencyKey,
  });
}

export async function job(id: string) {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  return call(operator, "jobs.get", "GET", `/v1/jobs/${id}`, parseJob);
}

/**
 * Polls several jobs at once (preparation). Jobs the service no longer knows
 * are listed as missing; any other failed lookup fails the poll.
 */
export async function jobsById(
  ids: string[],
): Promise<ServiceResult<{ jobs: Job[]; missing: string[] }>> {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  const results = await Promise.all(
    ids.map(async (id) => ({
      id,
      result: await call(operator, "jobs.get", "GET", `/v1/jobs/${id}`, parseJob),
    })),
  );
  const jobs: Job[] = [];
  const missing: string[] = [];
  for (const { id, result } of results) {
    if (result.ok) jobs.push(result.data);
    else if (!result.offline && result.error.code === "NOT_FOUND") missing.push(id);
    else return result;
  }
  return { ok: true, data: { jobs, missing } };
}

export async function jobHistory(input: { kind?: JobKind; limit: number }) {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  const query = new URLSearchParams({ limit: String(input.limit) });
  if (input.kind) query.set("kind", input.kind);
  return call(operator, "jobs.list", "GET", `/v1/jobs?${query}`, parseJobs);
}

export async function cancelJob(input: { id: string; idempotencyKey: string }) {
  const operator = await authorize(true);
  if (isFailure(operator)) return operator;
  return call(operator, "jobs.cancel", "POST", `/v1/jobs/${input.id}/cancel`, parseJob, {
    body: {},
    idempotencyKey: input.idempotencyKey,
  });
}

export async function batch(id: string) {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  return call(operator, "batches.get", "GET", `/v1/batches/${id}`, parseBatch);
}

export async function batchHistory(limit: number) {
  const operator = await authorize(false);
  if (isFailure(operator)) return operator;
  return call(operator, "batches.list", "GET", `/v1/batches?limit=${limit}`, parseBatches);
}

const PASSTHROUGH = ["Content-Type", "Content-Disposition", "Content-Length", "ETag"];

function plain(status: number, message: string) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Streams an artifact for the signed-in member; the service scopes it to the business. */
export async function artifactResponse(id: string): Promise<Response> {
  const operator = await authorize(false);
  if (isFailure(operator)) {
    const code = operator.ok === false && !operator.offline ? operator.error.code : "";
    return plain(code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN" ? 403 : 503, "Unavailable");
  }
  const response = await send(operator, "artifacts.get", "GET", `/v1/artifacts/${id}`, {
    timeoutMs: ARTIFACT_TIMEOUT_MS,
  });
  if (isFailure(response)) {
    const code = response.ok === false && !response.offline ? response.error.code : "OFFLINE";
    return plain(code === "PRODUCTION_DISABLED" ? 404 : 503, "Local processing service offline");
  }
  if (!response.ok || !response.body) {
    logFailure("artifacts.get", { status: response.status });
    return plain(response.status === 404 ? 404 : 502, "Artifact unavailable");
  }
  const result = new Headers();
  for (const name of PASSTHROUGH) {
    const value = response.headers.get(name);
    if (value) result.set(name, value);
  }
  if (!result.has("Content-Type")) result.set("Content-Type", "application/octet-stream");
  // SVG previews are opened from our origin; never let them run script.
  result.set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  return new Response(response.body, { status: 200, headers: result });
}
