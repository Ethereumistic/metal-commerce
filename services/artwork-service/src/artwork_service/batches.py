"""Batches: sizing snapshots, the nest job and batch results.

Creating a batch freezes the request, the master revisions it references, the
computed sizes and fit/feature checks. Nesting runs as a job: lines are grouped
by (material, thickness), each group is nested and independently validated,
and only a batch whose every instance is placed on a valid layout with verified
DXFs is published as `completed` with a downloadable ZIP. Anything else ends
`incomplete`, `failed` or `cancelled` with explicit counts and reasons.

The nesting, validation and DXF export modules are imported lazily inside the
job so the service (tracing, sizing, API) works without them.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import shapely

from . import geometry as geo
from . import jobs, sizing
from .config import SERVICE_VERSION, Config
from .contracts import BatchRequest
from .errors import JobCancelled, ServiceError
from .products import load_master_geometry
from .storage import dumps, loads, new_id, utcnow
from .tracing import TRACE_ENGINE, TRACE_VERSION

if TYPE_CHECKING:
    from .worker import JobContext

NEST_STATES_REUSABLE = ("draft", "incomplete", "failed", "cancelled")


def group_key(material: str, thickness_mm: float) -> str:
    return f"{material}/{thickness_mm:g}mm"


def _profile(conn: sqlite3.Connection, business_id: str, material: str, thickness_mm: float) -> sqlite3.Row:
    """Latest fabrication profile for a material/thickness, created with unknown limits if absent."""
    row = conn.execute("SELECT * FROM fabrication_profiles WHERE business_id = ? AND material = ? AND thickness_mm = ?"
                       " ORDER BY revision DESC LIMIT 1", (business_id, material, thickness_mm)).fetchone()
    if row is not None:
        return row
    conn.execute("INSERT INTO fabrication_profiles (id, business_id, material, thickness_mm, revision, created_at)"
                 " VALUES (?, ?, ?, ?, 1, ?)", (new_id(), business_id, material, thickness_mm, utcnow()))
    return _profile(conn, business_id, material, thickness_mm)


def _size_variant(conn: sqlite3.Connection, business_id: str, master_id: str, size: sizing.SizedPart) -> tuple[str, str]:
    key = sizing.part_key(master_id, size)
    row = conn.execute("SELECT id FROM size_variants WHERE business_id = ? AND part_key = ?",
                       (business_id, key)).fetchone()
    if row is not None:
        return row["id"], key
    variant_id = new_id()
    conn.execute("INSERT INTO size_variants (id, business_id, master_id, part_key, width_mm, height_mm,"
                 " geometry_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                 (variant_id, business_id, master_id, key, size.width_mm, size.height_mm, geo.GEOMETRY_VERSION,
                  utcnow()))
    return variant_id, key


def create_batch(conn: sqlite3.Connection, business_id: str, actor: str | None, req: BatchRequest,
                 config: Config) -> dict[str, Any]:
    stock = req.stock.model_dump()
    envelope = sizing.usable_envelope(stock)
    batch_id = new_id()
    lines_out: list[dict[str, Any]] = []
    snapshot_lines: list[dict[str, Any]] = []
    groups: dict[str, dict[str, Any]] = {}
    rows: list[tuple] = []
    for position, line in enumerate(req.lines):
        errors: list[dict[str, Any]] = []
        size: sizing.SizedPart | None = None
        variant_id = part_key = None
        feature: dict[str, Any] = {"status": "unknown", "message": "Not checked."}
        master = conn.execute("SELECT * FROM masters WHERE id = ? AND business_id = ?",
                              (line.master_id, business_id)).fetchone()
        linked = conn.execute("SELECT revision FROM product_masters WHERE business_id = ? AND product_id = ?"
                              " AND master_id = ?", (business_id, line.product_id, line.master_id)).fetchone()
        if master is None:
            errors.append({"code": "NOT_FOUND", "message": "The master does not exist.",
                           "details": {"master_id": line.master_id}})
        elif linked is None:
            errors.append({"code": "VALIDATION_ERROR", "message": "The master does not belong to this product.",
                           "details": {"master_id": line.master_id, "product_id": line.product_id}})
        profile = _profile(conn, business_id, line.material, line.thickness_mm)
        if master is not None and linked is not None:
            try:
                size = sizing.compute_size(master["aspect_ratio"], line.size.mode, line.size.width_mm,
                                           line.size.height_mm)
            except ServiceError as exc:
                errors.append(exc.to_dict())
        if size is not None:
            misfit = sizing.fit_check(size, envelope, line.allowed_rotations)
            if misfit:
                errors.append(misfit)
            variant_id, part_key = _size_variant(conn, business_id, line.master_id, size)
            if profile["min_feature_mm"] is None and profile["min_hole_mm"] is None:
                feature = sizing.unknown_feature_check()
            else:
                sized = sizing.sized_geometry(load_master_geometry(conn, business_id, line.master_id, config), size)
                feature = sizing.feature_check(sized, profile["min_feature_mm"], profile["min_hole_mm"])
        lines_out.append({
            "line_id": line.line_id,
            "actual_width_mm": size.width_mm if size else None,
            "actual_height_mm": size.height_mm if size else None,
            "fits": size is not None and not errors,
            "errors": errors,
            "feature_check": feature,
        })
        key = group_key(line.material, line.thickness_mm)
        group = groups.setdefault(key, {"group_key": key, "material": line.material,
                                        "thickness_mm": line.thickness_mm, "line_ids": [], "instance_count": 0})
        group["line_ids"].append(line.line_id)
        group["instance_count"] += line.quantity
        snapshot_lines.append({
            "line_id": line.line_id,
            "product_id": line.product_id,
            "master": None if master is None else {
                "master_id": master["id"], "product_revision": linked["revision"] if linked else None,
                "source_sha256": master["source_sha256"], "trace_engine": master["trace_engine"],
                "trace_version": master["trace_version"], "aspect_ratio": master["aspect_ratio"],
            },
            "part_key": part_key,
            "actual_width_mm": size.width_mm if size else None,
            "actual_height_mm": size.height_mm if size else None,
            "profile": {"id": profile["id"], "revision": profile["revision"],
                        "min_feature_mm": profile["min_feature_mm"], "min_hole_mm": profile["min_hole_mm"]},
            "feature_check": feature,
        })
        rows.append((batch_id, line.line_id, business_id, position, line.product_id, line.master_id, variant_id,
                     profile["id"], line.size.mode, line.size.width_mm, line.size.height_mm,
                     size.width_mm if size else None, size.height_mm if size else None, line.quantity,
                     line.material, line.thickness_mm, dumps(line.allowed_rotations), line.variant_id,
                     int(size is not None and not errors), dumps(errors), dumps(feature)))

    status = "invalid" if any(line["errors"] for line in lines_out) else "draft"
    now = utcnow()
    snapshot = {
        "lines": snapshot_lines,
        "stock": stock,
        "usable_envelope_mm": {"width_mm": envelope.width_mm, "height_mm": envelope.height_mm},
        "versions": {"service": SERVICE_VERSION, "trace_engine": TRACE_ENGINE, "trace_version": TRACE_VERSION,
                     "geometry": geo.GEOMETRY_VERSION},
    }
    group_list = sorted(groups.values(), key=lambda g: g["group_key"])
    conn.execute("INSERT INTO batches (id, business_id, name, status, request, snapshot, groups, created_by,"
                 " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (batch_id, business_id, req.name, status, dumps(req.model_dump()), dumps(snapshot),
                  dumps(group_list), actor, now, now))
    conn.executemany(
        "INSERT INTO batch_lines (batch_id, line_id, business_id, position, product_id, master_id, size_variant_id,"
        " profile_id, size_mode, requested_width_mm, requested_height_mm, actual_width_mm, actual_height_mm,"
        " quantity, material, thickness_mm, allowed_rotations, variant_id, fits, errors, feature_check)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return {"batch_id": batch_id, "status": status, "lines": lines_out, "groups": group_list}


def _batch(conn: sqlite3.Connection, business_id: str, batch_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM batches WHERE id = ? AND business_id = ?", (batch_id, business_id)).fetchone()
    if row is None:
        raise ServiceError("NOT_FOUND", "Batch not found.", {"batch_id": batch_id})
    return row


def request_nest(conn: sqlite3.Connection, business_id: str, batch_id: str, config: Config) -> dict[str, Any]:
    batch = _batch(conn, business_id, batch_id)
    if batch["status"] in ("queued", "nesting"):
        return {"job_id": batch["job_id"]}
    if batch["status"] == "invalid":
        raise ServiceError("VALIDATION_ERROR", "The batch has invalid lines; fix them in a new batch.",
                           {"batch_id": batch_id}, status=409)
    if batch["status"] == "completed":
        raise ServiceError("VALIDATION_ERROR", "Completed batches are immutable.", {"batch_id": batch_id},
                           status=409)
    request = loads(batch["request"])
    # Previous unsuccessful attempts leave no published sheets behind.
    conn.execute("DELETE FROM placements WHERE batch_id = ?", (batch_id,))
    conn.execute("DELETE FROM sheets WHERE batch_id = ?", (batch_id,))
    groups = len(loads(batch["groups"]))
    timeout = request["optimization"]["time_budget_s"] * groups + config.nest_overhead_s
    job_id = jobs.enqueue(conn, business_id=business_id, kind="nest", payload={"batch_id": batch_id},
                          max_attempts=config.max_attempts, timeout_s=timeout)
    conn.execute("UPDATE batches SET status = 'queued', job_id = ?, error = NULL, totals = NULL, validation = NULL,"
                 " manifest_artifact = NULL, zip_artifact = NULL, updated_at = ? WHERE id = ?",
                 (job_id, utcnow(), batch_id))
    return {"job_id": job_id}


# ------------------------------------------------------------------- nest job


def _set_batch(conn: sqlite3.Connection, batch_id: str, **fields: Any) -> None:
    fields["updated_at"] = utcnow()
    assignments = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE batches SET {assignments} WHERE id = ?", (*fields.values(), batch_id))


def nest_failed(conn: sqlite3.Connection, job: sqlite3.Row, error: dict[str, Any], status: str) -> None:
    batch_id = loads(job["payload"])["batch_id"]
    batch = conn.execute("SELECT job_id FROM batches WHERE id = ?", (batch_id,)).fetchone()
    if batch is None or batch["job_id"] != job["id"]:
        return
    conn.execute("DELETE FROM placements WHERE batch_id = ?", (batch_id,))
    conn.execute("DELETE FROM sheets WHERE batch_id = ?", (batch_id,))
    _set_batch(conn, batch_id, status="cancelled" if status == "cancelled" else "failed", error=dumps(error),
               zip_artifact=None)


def _import_engine() -> dict[str, Any]:
    try:
        from . import dxf_export, nesting, validation
        from .nesting_types import NestingError, PartSpec, StockSpec
    except ImportError as exc:
        raise ServiceError("INTERNAL_ERROR", "The nesting/export engine is not installed in this service build.",
                           {"module": getattr(exc, "name", None)}) from exc
    return {"nesting": nesting, "validation": validation, "dxf_export": dxf_export, "NestingError": NestingError,
            "PartSpec": PartSpec, "StockSpec": StockSpec}


def _sheet_extent(placed: list[Any], stock: dict[str, Any]) -> float:
    """Occupied length along the sheet's long axis, measured from the usable edge."""
    if not placed:
        return 0.0
    _minx, _miny, maxx, maxy = (float(v) for v in shapely.total_bounds(placed))
    if stock["height_mm"] >= stock["width_mm"]:
        return maxy - stock["margins_mm"]["bottom"]
    return maxx - stock["margins_mm"]["left"]


def run_nest_job(ctx: "JobContext") -> None:
    engine = _import_engine()
    from .nesting_types import place_geometry  # noqa: PLC0415  (engine present: checked above)

    job = ctx.job
    business_id = job["business_id"]
    batch_id = loads(job["payload"])["batch_id"]
    with ctx.db.tx() as conn:
        batch = _batch(conn, business_id, batch_id)
        if batch["job_id"] != job["id"]:
            raise ServiceError("VALIDATION_ERROR", "This job no longer owns the batch.", {"batch_id": batch_id})
        _set_batch(conn, batch_id, status="nesting")
        lines = conn.execute("SELECT * FROM batch_lines WHERE batch_id = ? ORDER BY position", (batch_id,)).fetchall()
        request = loads(batch["request"])
        snapshot = loads(batch["snapshot"])
        names = {}
        for line in lines:
            row = conn.execute("SELECT name FROM product_sources WHERE business_id = ? AND product_id = ?"
                               " AND name IS NOT NULL ORDER BY created_at DESC LIMIT 1",
                               (business_id, line["product_id"])).fetchone()
            names[line["product_id"]] = row["name"] if row else line["product_id"]
        geometries = {}
        for line in lines:
            if line["master_id"] not in geometries:
                geometries[line["master_id"]] = load_master_geometry(conn, business_id, line["master_id"], ctx.config)

    stock_req = request["stock"]
    m = stock_req["margins_mm"]
    stock = engine["StockSpec"](
        width_mm=stock_req["width_mm"], height_mm=stock_req["height_mm"], margin_left=m["left"],
        margin_right=m["right"], margin_bottom=m["bottom"], margin_top=m["top"], gap_mm=stock_req["gap_mm"],
        max_sheets=stock_req["max_sheets"])
    groups: dict[str, list[Any]] = {}
    group_meta: dict[str, dict[str, Any]] = {}
    for line in lines:
        size = sizing.SizedPart(line["actual_width_mm"], line["actual_height_mm"])
        part = engine["PartSpec"](
            part_key=sizing.part_key(line["master_id"], size),
            geometry=sizing.sized_geometry(geometries[line["master_id"]], size),
            instance_ids=tuple(f"{line['line_id']}#{n:04d}" for n in range(1, line["quantity"] + 1)),
            line_id=line["line_id"], product_id=line["product_id"],
            allowed_rotations=tuple(loads(line["allowed_rotations"])))
        key = group_key(line["material"], line["thickness_mm"])
        groups.setdefault(key, []).append(part)
        group_meta[key] = {"material": line["material"], "thickness_mm": line["thickness_mm"]}

    budget = float(request["optimization"]["time_budget_s"])
    seed = int(request["optimization"]["seed"])
    outcomes: dict[str, Any] = {}
    reports: dict[str, Any] = {}
    keys = sorted(groups)
    for i, key in enumerate(keys):
        base, share = 0.05 + 0.75 * i / len(keys), 0.75 / len(keys)
        ctx.checkpoint(base, f"nesting {key}")

        def progress(p: float, stage: str, base: float = base, share: float = share, key: str = key) -> None:
            ctx.report(base + share * max(0.0, min(1.0, p)), f"nesting {key}: {stage}")

        try:
            outcome = engine["nesting"].nest_group(groups[key], stock, time_budget_s=budget, seed=seed,
                                                    cancel=ctx.is_cancelled, progress=progress)
        except engine["NestingError"] as exc:
            raise ServiceError(exc.code, exc.message, {"group_key": key, **exc.details}) from exc
        if outcome.status == "cancelled":
            ctx.checkpoint()  # raises JobCancelled / JobTimeout with the right reason
            raise JobCancelled(ctx.job_id)
        outcomes[key] = outcome
        reports[key] = engine["validation"].validate_layout(groups[key], stock, outcome.sheets, allow_unplaced=True)

    ctx.checkpoint(0.82, "validating")
    invalid = {k: r for k, r in reports.items() if not r.valid}
    if invalid:
        raise ServiceError("LAYOUT_INVALID", "The nesting result failed independent layout validation; "
                           "nothing was exported.",
                           {k: [v.to_dict() for v in r.violations[:20]] for k, r in invalid.items()})

    requested = sum(r.requested for r in reports.values())
    placed = sum(r.placed for r in reports.values())
    complete = placed == requested and all(o.status == "complete" for o in outcomes.values())

    package = None
    if complete:
        ctx.checkpoint(0.85, "exporting")
        try:
            package = engine["dxf_export"].build_package(
                batch_id,
                [engine["dxf_export"].PackageGroup(
                    group_key=key, material=group_meta[key]["material"],
                    thickness_mm=group_meta[key]["thickness_mm"], parts=groups[key], stock=stock,
                    outcome=outcomes[key], stock_label=stock_req.get("label") or "") for key in keys],
                chord_tolerance_mm=request["export"]["chord_tolerance_mm"],
                context={"batch_id": batch_id, "name": batch["name"], "request": request, "snapshot": snapshot},
                created_at=datetime.now(UTC),
                versions={"service": SERVICE_VERSION, "trace_engine": TRACE_ENGINE, "trace_version": TRACE_VERSION,
                          "geometry": geo.GEOMETRY_VERSION},
                product_labels=names,
            )
        except engine["NestingError"] as exc:
            raise ServiceError(exc.code, exc.message, exc.details) from exc

    # Per-sheet records and metrics.
    sheet_records = []
    number = 0
    metal_total = 0.0
    extents: dict[str, float] = {}
    for key in keys:
        by_part = {p.part_key: p for p in groups[key]}
        for index, placements in enumerate(outcomes[key].sheets):
            number += 1
            shapes = [place_geometry(by_part[p.part_key].geometry, p.rotation_deg, p.tx_mm, p.ty_mm)
                      for p in placements]
            metal = sum(s.area for s in shapes)
            metal_total += metal
            extent = _sheet_extent(shapes, stock_req)
            extents[key] = extent
            sheet_area = stock_req["width_mm"] * stock_req["height_mm"]
            leftover = outcomes[key].metrics["sheets"][index]["leftover_usable_area_mm2"]
            sheet_records.append({
                "sheet_id": new_id(), "group_key": key, "index": index, "number": number,
                "placements": placements,
                "metrics": {"parts": len(placements), "metal_area_mm2": round(metal, 3),
                            "sheet_area_mm2": sheet_area, "utilization": round(metal / sheet_area, 6),
                            "occupied_extent_mm": round(extent, 3),
                            "leftover_usable_area_mm2": round(leftover, 3)},
            })
    sheet_area_total = len(sheet_records) * stock_req["width_mm"] * stock_req["height_mm"]
    totals = {
        "requested": requested,
        "placed": placed,
        "unplaced": requested - placed,
        "sheet_count": len(sheet_records),
        "metal_area_mm2": round(metal_total, 3),
        "sheet_area_mm2": sheet_area_total,
        "utilization": round(metal_total / sheet_area_total, 6) if sheet_area_total else 0.0,
        "occupied_extent_mm": round(max(extents.values()), 3) if extents else 0.0,
        "occupied_extent_by_group_mm": {k: round(v, 3) for k, v in extents.items()},
        "leftover_usable_area_mm2": round(sum(o.metrics["leftover_usable_area_mm2"] for o in outcomes.values()), 3),
        "leftover_usable_area_by_group_mm2": {k: round(o.metrics["leftover_usable_area_mm2"], 3)
                                              for k, o in outcomes.items()},
        "engine_by_group": {k: o.engine for k, o in outcomes.items()},
        "runtime_s": round(sum(o.runtime_s for o in outcomes.values()), 3),
        "optimization_status": "complete" if complete else "incomplete",
        "groups": {k: {"engine": o.engine, "engine_version": o.engine_version, "status": o.status,
                       "runtime_s": o.runtime_s, "settings": o.settings, "metrics": o.metrics,
                       "baseline_metrics": o.baseline_metrics, "unplaced": len(o.unplaced_instance_ids)}
                   for k, o in outcomes.items()},
        "definitions": {
            "utilization": "sum of placed nominal part areas (holes excluded) / (sheet_count × sheet width × height)",
            "occupied_extent_mm": "per group, length along the sheet's long axis from the usable edge to the "
                                  "farthest placed part on the group's last sheet; the total is the maximum",
            "leftover_usable_area_mm2": "per sheet, usable area outside the occupied box (from the usable origin "
                                        "corner to the farthest part plus the gap, on both axes): the uncut strip "
                                        "beyond the parts plus the free side column; the total sums all sheets",
            "engine_by_group": "nesting engine that produced each group's layout: packingsolver-irregular or "
                               "bbox-baseline (the fallback); gap filling may have moved parts afterwards "
                               "(groups.<key>.metrics.gap_fill_moves)",
        },
    }
    validation = {k: r.to_dict() for k, r in reports.items()}

    files_by_sheet: dict[int, dict[str, Any]] = {}
    manifest_file = zip_bytes = None
    if package is not None:
        for f in package.files:
            if f.kind == "manifest":
                manifest_file = f
            elif f.sheet_number is not None:
                files_by_sheet.setdefault(f.sheet_number, {})[f.kind] = f
        zip_bytes = package.zip_bytes
    else:
        svg_maker = engine["dxf_export"].export_sheet_svg
        for rec in sheet_records:
            svg = svg_maker(groups[rec["group_key"]], stock, rec["placements"],
                            title=f"Batch {batch_id} sheet {rec['number']} (incomplete)", labels=names)
            files_by_sheet[rec["number"]] = {"svg": svg.encode()}

    ctx.checkpoint(0.92, "writing-artifacts")
    payloads: list[bytes] = [zip_bytes] if zip_bytes else []
    for entry in files_by_sheet.values():
        payloads.extend(getattr(v, "content", v) for v in entry.values())
    if manifest_file is not None:
        payloads.append(manifest_file.content)
    else:
        manifest_doc = {"manifest_version": 1, "batch_id": batch_id, "status": "incomplete", "totals": totals,
                        "validation": validation, "context": {"request": request, "snapshot": snapshot},
                        "note": "Incomplete batch: no DXF files or ZIP are published for production."}
        manifest_bytes = (json.dumps(manifest_doc, indent=2, sort_keys=True, default=str) + "\n").encode()
        payloads.append(manifest_bytes)
    for content in payloads:
        ctx.store.write_bytes(content)

    ctx.checkpoint(0.97, "publishing")
    width, height = stock_req["width_mm"], stock_req["height_mm"]
    with ctx.db.tx() as conn:
        put = ctx.store.put
        for rec in sheet_records:
            entry = files_by_sheet.get(rec["number"], {})
            stem = f"batch-{batch_id}-sheet-{rec['number']:03d}-{width:g}x{height:g}mm"
            dxf_id = svg_id = None
            if "dxf" in entry:
                dxf_id = put(conn, business_id, entry["dxf"].content, kind="sheet_dxf", ext="dxf",
                             filename=entry["dxf"].name)
            if "svg" in entry:
                svg = entry["svg"]
                svg_id = put(conn, business_id, getattr(svg, "content", svg), kind="sheet_svg", ext="svg",
                             filename=getattr(svg, "name", f"{stem}.svg"))
            conn.execute("INSERT INTO sheets (id, batch_id, business_id, group_key, sheet_index, sheet_number,"
                         " width_mm, height_mm, metrics, dxf_artifact, svg_artifact)"
                         " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         (rec["sheet_id"], batch_id, business_id, rec["group_key"], rec["index"], rec["number"],
                          width, height, dumps(rec["metrics"]), dxf_id, svg_id))
            conn.executemany(
                "INSERT INTO placements (batch_id, sheet_id, instance_id, line_id, product_id, part_key,"
                " rotation_deg, tx_mm, ty_mm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(batch_id, rec["sheet_id"], p.instance_id, p.line_id, p.product_id, p.part_key, p.rotation_deg,
                  p.tx_mm, p.ty_mm) for p in rec["placements"]])
        if manifest_file is not None:
            manifest_id = put(conn, business_id, manifest_file.content, kind="manifest", ext="json",
                              filename=f"batch-{batch_id}-manifest.json")
        else:
            manifest_id = put(conn, business_id, payloads[-1], kind="manifest", ext="json",
                              filename=f"batch-{batch_id}-manifest.json")
        zip_id = None
        if zip_bytes is not None:
            zip_id = put(conn, business_id, zip_bytes, kind="zip", ext="zip", filename=f"batch-{batch_id}.zip")
        if complete:
            # The manifest/ZIP were published above; the status flip is last.
            _set_batch(conn, batch_id, status="completed", totals=dumps(totals), validation=dumps(validation),
                       manifest_artifact=manifest_id, zip_artifact=zip_id, error=None)
            ctx.complete(conn, {"batch_id": batch_id})
        else:
            error = {"code": "NEST_INCOMPLETE",
                     "message": f"{requested - placed} of {requested} instances could not be placed within the "
                                "sheet limit and time budget; no production files were published.",
                     "details": {"requested": requested, "placed": placed, "unplaced": requested - placed,
                                 "unplaced_instance_ids": sorted(
                                     i for o in outcomes.values() for i in o.unplaced_instance_ids)[:200]}}
            _set_batch(conn, batch_id, status="incomplete", totals=dumps(totals), validation=dumps(validation),
                       manifest_artifact=manifest_id, zip_artifact=None, error=dumps(error))
            jobs.finish(conn, ctx.job_id, ctx.owner, status="failed", error=error, result={"batch_id": batch_id})
            ctx.completed = True


# ---------------------------------------------------------------------- views


def batch_view(conn: sqlite3.Connection, business_id: str, batch_id: str) -> dict[str, Any]:
    batch = _batch(conn, business_id, batch_id)
    sheets = []
    for s in conn.execute("SELECT * FROM sheets WHERE batch_id = ? ORDER BY sheet_number", (batch_id,)):
        placements = [
            {"instance_id": p["instance_id"], "line_id": p["line_id"], "product_id": p["product_id"],
             "rotation_deg": p["rotation_deg"], "tx_mm": p["tx_mm"], "ty_mm": p["ty_mm"]}
            for p in conn.execute("SELECT * FROM placements WHERE sheet_id = ? ORDER BY instance_id", (s["id"],))
        ]
        sheets.append({"sheet_id": s["id"], "group_key": s["group_key"], "index": s["sheet_number"],
                       "group_sheet_index": s["sheet_index"], "width_mm": s["width_mm"], "height_mm": s["height_mm"],
                       "placements": placements, "metrics": loads(s["metrics"]),
                       "dxf": s["dxf_artifact"], "svg": s["svg_artifact"]})
    lines = [
        {"line_id": r["line_id"], "product_id": r["product_id"], "master_id": r["master_id"],
         "quantity": r["quantity"], "material": r["material"], "thickness_mm": r["thickness_mm"],
         "actual_width_mm": r["actual_width_mm"], "actual_height_mm": r["actual_height_mm"],
         "fits": bool(r["fits"]), "errors": loads(r["errors"]), "feature_check": loads(r["feature_check"])}
        for r in conn.execute("SELECT * FROM batch_lines WHERE batch_id = ? ORDER BY position", (batch_id,))
    ]
    completed = batch["status"] == "completed"
    return {
        "batch_id": batch["id"],
        "name": batch["name"],
        "status": batch["status"],
        "job_id": batch["job_id"],
        "error": loads(batch["error"]),
        "request": loads(batch["request"]),
        "snapshot": loads(batch["snapshot"]),
        "lines": lines,
        "groups": loads(batch["groups"]),
        "sheets": [{k: v for k, v in s.items() if k not in ("dxf", "svg")} for s in sheets],
        "totals": loads(batch["totals"]),
        "validation": loads(batch["validation"]),
        "artifacts": {
            "zip": batch["zip_artifact"] if completed else None,
            "manifest": batch["manifest_artifact"],
            "sheets": [{"sheet_id": s["sheet_id"], "dxf": s["dxf"] if completed else None, "svg": s["svg"]}
                       for s in sheets],
        },
        "created_at": batch["created_at"],
        "updated_at": batch["updated_at"],
    }


def list_batches(conn: sqlite3.Connection, business_id: str, limit: int) -> dict[str, Any]:
    rows = conn.execute("SELECT * FROM batches WHERE business_id = ? ORDER BY created_at DESC, id LIMIT ?",
                        (business_id, limit)).fetchall()
    return {"items": [{"batch_id": r["id"], "name": r["name"], "status": r["status"], "job_id": r["job_id"],
                       "totals": loads(r["totals"]), "groups": loads(r["groups"]), "created_at": r["created_at"],
                       "updated_at": r["updated_at"]} for r in rows]}
