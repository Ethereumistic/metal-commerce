# Shared contract for the artwork production feature (v1)

Authoritative feature plan: /home/echo/Documents/metal-commerce/docs/artwork-production-implementation-plan.md (read it fully; this contract fixes the interfaces between parallel work units). Copy this file into the repo as `services/artwork-service/CONTRACT.md` if you own the service core; others reference it.

## Layout
- Service: `services/artwork-service/` (Python 3.12 via uv — `uv python` has cpython-3.12 installed; system python is 3.14, do not use it, never install into system Python). Package `src/artwork_service/`. Tests with pytest under `services/artwork-service/tests/`.
- Admin: `apps/admin/src/features/production/*`, `apps/admin/src/lib/production.server.ts`, `apps/admin/src/lib/production-catalog.server.ts`.
- Data dir: env `ARTWORK_DATA_DIR` (default `/home/echo/.local/share/metal-craft-artwork/dev`; tests use a tmp dir). Bind `127.0.0.1`, port env `ARTWORK_PORT` default 8766.

## Pinned dependencies (Python)
fastapi 0.162.0, pydantic 2.14.1, uvicorn 0.54.0, numpy 2.5.4, opencv-python-headless 5.0.0.93, shapely 2.2.0, ezdxf 1.4.5, pillow 13.0.0, packingsolver 0.1.1218 (PyPI wheel cp312-abi3, exposes `packingsolver.irregular`), httpx (pin current), pytest (dev). If a pin fails to resolve, pick the nearest working version and record it.

## Service auth (every route except none — /v1/health also requires auth)
- Header `Authorization: Bearer <ARTWORK_SERVICE_TOKEN>` (env on both sides; constant-time compare). Missing/invalid → 401.
- Header `X-Artwork-Business-Id: <businessId>` required; all rows are scoped by business_id; lookups of another business's IDs return 404.
- Header `X-Artwork-Actor: <userId>` and `X-Artwork-Can-Edit: true|false` asserted by the admin server; mutations require can-edit true (else 403).
- Mutations require `Idempotency-Key` header; stored with SHA256 fingerprint of canonical JSON body; same key + different body → 409 `IDEMPOTENCY_CONFLICT`; same key + same body → replay original response.
- Hosted path additionally passes Cloudflare Access `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers (only consumed by Cloudflare; service ignores them).

## Error envelope
`{"error": {"code": "SOURCE_UNAVAILABLE", "message": "human readable actionable", "details": {...}}}` with appropriate HTTP status. Failure codes include: NO_FIRST_IMAGE, SOURCE_UNAVAILABLE, SOURCE_TOO_SMALL, SOURCE_TOO_LARGE, UNSUPPORTED_FORMAT, SOURCE_HOST_NOT_ALLOWED, LOW_CONTRAST, AMBIGUOUS_SEGMENTATION, DISCONNECTED_MATERIAL, OBJECT_CLIPPED, INVALID_CONTOURS, PART_DOES_NOT_FIT, INVALID_DIMENSIONS, INSUFFICIENT_STOCK, NEST_INCOMPLETE, LAYOUT_INVALID, EXPORT_INVALID, CANCELLED, TIMEOUT, INSUFFICIENT_DISK, MASTER_STALE, IDEMPOTENCY_CONFLICT, NOT_FOUND, FORBIDDEN, UNAUTHORIZED, VALIDATION_ERROR.

## HTTP API (JSON, snake_case)
- `GET /v1/health` → `{service_version, worker_ready, queue: {queued, running}, tracer_version, solver_version, exporter_version}`
- `POST /v1/prepare` body `{products: [{product_id, product_revision, name, slug, source: {gallery_index: 0, source_identity, source_version|null, original_url, width|null, height|null}}], reprocess: false}` (max 50 products). Admin resolves the first image server-side; if a product has no first image, admin sends `source: null` and service records `failed/NO_FIRST_IMAGE`. → `{items: [{product_id, status: unprepared|queued|processing|ready|failed|stale, master_id|null, job_id|null, error|null}]}`
- `POST /v1/products/status` body `{products: [{product_id, source_identity, source_version|null}]}` → same items shape; marks `stale` when the active master's source identity/version differs from what is passed (does not enqueue).
- `GET /v1/masters/{id}` → `{id, product_id, revision, source: {...snapshot, byte_sha256, width, height}, aspect_ratio (w/h), normalized_bounds, components, holes, vertex_count, trace_engine, trace_version, trace_settings, diagnostics: {threshold, candidates, noise_removed_area_px, warnings[]}, artifacts: {overlay_png, solid_png, master_json, master_svg}, created_at}`
- `POST /v1/batches` body `{name|null, lines: [{line_id, product_id, master_id, size: {mode: "width"|"height"|"fit", width_mm|null, height_mm|null}, quantity, material, thickness_mm, allowed_rotations: [0,90,180,270], variant_id|null}], stock: {width_mm, height_mm, margins_mm: {left,right,bottom,top}, gap_mm, max_sheets, label}, optimization: {time_budget_s: 10|30|120, seed: int}, export: {chord_tolerance_mm: 0.05}}` → `{batch_id, status: "draft"|"invalid", lines: [{line_id, actual_width_mm, actual_height_mm, fits: bool, errors: []}], groups: [{group_key, material, thickness_mm, line_ids, instance_count}]}`. Validates fit before any optimization (PART_DOES_NOT_FIT with part dims and usable envelope).
- `POST /v1/batches/{id}/nest` → `{job_id}` (202, immediately)
- `GET /v1/jobs/{id}` → `{id, kind: "trace"|"nest", status: queued|running|succeeded|failed|cancelled, stage, progress (0..1), heartbeat_at, attempts, cache_hit, error|null, result: {master_id}|{batch_id}|null, created_at, updated_at}`
- `GET /v1/jobs?kind=&limit=` → recent jobs for history.
- `POST /v1/jobs/{id}/cancel` → idempotent, returns job.
- `GET /v1/batches/{id}` → `{batch_id, status: draft|invalid|queued|nesting|completed|incomplete|failed|cancelled, request (frozen), groups, sheets: [{sheet_id, group_key, index, width_mm, height_mm, placements: [{instance_id, line_id, product_id, rotation_deg, tx_mm, ty_mm}], metrics}], totals: {requested, placed, unplaced, sheet_count, metal_area_mm2, sheet_area_mm2, utilization, occupied_extent_mm, runtime_s, optimization_status}, validation, artifacts: {zip|null, manifest, sheets: [{sheet_id, dxf, svg}]}}`. ZIP only present when status completed (all instances placed + validated).
  - Additive (nesting 1.1): `sheets[].metrics.leftover_usable_area_mm2`; `totals.leftover_usable_area_mm2`, `totals.leftover_usable_area_by_group_mm2: {group_key: mm2}`, `totals.engine_by_group: {group_key: "packingsolver-irregular"|"bbox-baseline"}`; `totals.groups.<key>.metrics` gains `leftover_usable_area_mm2`, `last_sheet_leftover_usable_area_mm2`, `engine`, `gap_fill_moves` and per-sheet `leftover_usable_area_mm2`; `totals.groups.<key>.settings` gains `selection`, `gap_fill` and per-attempt `build_s`/`solution_times_s`. Leftover usable area = usable area outside the occupied box (usable origin corner to the farthest part + gap on both axes): the uncut strip beyond the parts plus the free side column. Definitions in docs/nesting-and-export.md (Metrics).
- `GET /v1/batches?limit=` → history list.
- `GET /v1/artifacts/{id}` → streamed bytes, correct Content-Type, `Content-Disposition: attachment; filename="batch-<id>-sheet-001-1500x3000mm.dxf"` etc. Scoped by business.

## Internal Python module contract (between core and nesting/export modules)
Geometry passed to nesting/validation/export is Shapely, millimetres, Y-up, part reference origin = lower-left of the part's un-rotated bounding box (minx=miny=0).

```python
# artwork_service/nesting_types.py  (owned by nesting unit)
@dataclass(frozen=True)
class PartSpec:
    part_key: str                 # sized-geometry identity (master revision + size + algo version)
    geometry: shapely.MultiPolygon   # nominal contours incl. holes, mm, Y-up, bbox minx=miny=0
    instance_ids: tuple[str, ...]    # stable ids, e.g. f"{line_id}#{n:04d}"
    line_id: str
    product_id: str
    allowed_rotations: tuple[int, ...]   # degrees, subset of 0/90/180/270 by default; mirror never
@dataclass(frozen=True)
class StockSpec:
    width_mm: float; height_mm: float
    margin_left: float; margin_right: float; margin_bottom: float; margin_top: float
    gap_mm: float; max_sheets: int
@dataclass(frozen=True)
class Placement:
    instance_id: str; part_key: str; line_id: str; product_id: str
    rotation_deg: int; tx_mm: float; ty_mm: float
    # world = rotate(geometry, rotation_deg, origin=(0,0)) translated by (tx, ty); sheet lower-left origin.
@dataclass
class NestOutcome:
    sheets: list[list[Placement]]
    unplaced_instance_ids: list[str]
    status: str     # "complete" | "incomplete" | "cancelled" | "failed"
    engine: str     # "packingsolver-irregular" | "bbox-baseline"
    engine_version: str; settings: dict; runtime_s: float
    metrics: dict   # per-sheet and total, formulas documented (incl. leftover_usable_area_mm2, engine, gap_fill_moves)
    baseline_metrics: dict   # bbox baseline comparison

def nest_group(parts: list[PartSpec], stock: StockSpec, *, time_budget_s: float, seed: int,
               cancel: Callable[[], bool], progress: Callable[[float, str], None]) -> NestOutcome
def validate_layout(parts, stock, sheets) -> ValidationReport   # independent; never trusts solver flags
def export_sheet_dxf(parts, stock, placements, *, chord_tolerance_mm) -> bytes   # layer 0 only, LWPOLYLINE closed
def export_sheet_svg(...) -> str  # preview with sheet outline, margins, labels (non-cutting)
def verify_dxf(dxf_bytes, parts, placements, tolerance_mm) -> DxfCheckReport  # independent reader path
def build_package(...)  # manifest.json + DXFs + SVGs -> zip bytes
```
