"""Test-only stand-in for the nesting/validation/export modules.

It exercises the nest-job wiring (grouping, persistence, status rules) without
the real solver. It shelf-packs bounding boxes at rotation 0 and is NOT a
nesting implementation.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import types
import zipfile
from dataclasses import dataclass, field
from typing import Any

from shapely import affinity


class NestingError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details or {}


@dataclass(frozen=True)
class PartSpec:
    part_key: str
    geometry: Any
    instance_ids: tuple[str, ...]
    line_id: str
    product_id: str
    allowed_rotations: tuple[int, ...] = (0, 90, 180, 270)


@dataclass(frozen=True)
class StockSpec:
    width_mm: float
    height_mm: float
    margin_left: float
    margin_right: float
    margin_bottom: float
    margin_top: float
    gap_mm: float
    max_sheets: int


@dataclass(frozen=True)
class Placement:
    instance_id: str
    part_key: str
    line_id: str
    product_id: str
    rotation_deg: int
    tx_mm: float
    ty_mm: float

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class NestOutcome:
    sheets: list
    unplaced_instance_ids: list
    status: str
    engine: str = "stub-shelf"
    engine_version: str = "0"
    settings: dict = field(default_factory=dict)
    runtime_s: float = 0.0
    metrics: dict = field(default_factory=dict)
    baseline_metrics: dict = field(default_factory=dict)


@dataclass
class Report:
    valid: bool
    requested: int
    placed: int
    unplaced_instance_ids: list
    violations: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"valid": self.valid, "requested": self.requested, "placed": self.placed,
                "unplaced_instance_ids": self.unplaced_instance_ids, "violations": []}


def place_geometry(geometry, rotation_deg, tx_mm, ty_mm):
    return affinity.translate(affinity.rotate(geometry, rotation_deg, origin=(0, 0)), tx_mm, ty_mm)


calls: list[dict] = []


def nest_group(parts, stock, *, time_budget_s, seed, cancel, progress):
    calls.append({"parts": parts, "stock": stock, "time_budget_s": time_budget_s, "seed": seed})
    sheets: list[list[Placement]] = [[]]
    x, y, row_h = stock.margin_left, stock.margin_bottom, 0.0
    unplaced: list[str] = []
    for part in parts:
        w, h = part.geometry.bounds[2], part.geometry.bounds[3]
        for iid in part.instance_ids:
            if x + w > stock.width_mm - stock.margin_right:
                x, y, row_h = stock.margin_left, y + row_h + stock.gap_mm, 0.0
            if y + h > stock.height_mm - stock.margin_top:
                if len(sheets) >= stock.max_sheets:
                    unplaced.append(iid)
                    continue
                sheets.append([])
                x, y, row_h = stock.margin_left, stock.margin_bottom, 0.0
            sheets[-1].append(Placement(iid, part.part_key, part.line_id, part.product_id, 0, x, y))
            x += w + stock.gap_mm
            row_h = max(row_h, h)
    progress(1.0, "done")
    sheets = [s for s in sheets if s]
    metrics = _metrics(parts, stock, sheets)
    return NestOutcome(sheets, unplaced, "incomplete" if unplaced else "complete", metrics=metrics)


def _metrics(parts, stock, sheets) -> dict:
    """The leftover fields batches.py reads (rotation 0 only, like the packer above)."""
    sizes = {p.part_key: p.geometry.bounds[2:] for p in parts}
    usable_w = stock.width_mm - stock.margin_left - stock.margin_right
    usable_h = stock.height_mm - stock.margin_bottom - stock.margin_top
    per_sheet = []
    for sheet in sheets:
        max_x = max(pl.tx_mm + sizes[pl.part_key][0] for pl in sheet)
        max_y = max(pl.ty_mm + sizes[pl.part_key][1] for pl in sheet)
        box_w = min(usable_w, max_x + stock.gap_mm - stock.margin_left)
        box_h = min(usable_h, max_y + stock.gap_mm - stock.margin_bottom)
        per_sheet.append({"leftover_usable_area_mm2": usable_w * usable_h - box_w * box_h})
    return {"sheets": per_sheet, "leftover_usable_area_mm2": sum(s["leftover_usable_area_mm2"] for s in per_sheet)}


def validate_layout(parts, stock, sheets, *, allow_unplaced=False, tolerance_mm=1e-6):
    ids = [i for p in parts for i in p.instance_ids]
    placed = [pl.instance_id for s in sheets for pl in s]
    unplaced = sorted(set(ids) - set(placed))
    valid = len(placed) == len(set(placed)) and (allow_unplaced or not unplaced)
    return Report(valid, len(ids), len(placed), unplaced)


@dataclass(frozen=True)
class PackageGroup:
    group_key: str
    material: str
    thickness_mm: float
    parts: Any
    stock: Any
    outcome: Any
    stock_label: str = ""


@dataclass(frozen=True)
class PackageFile:
    name: str
    kind: str
    content: bytes
    sha256: str
    group_key: str | None = None
    sheet_number: int | None = None


@dataclass(frozen=True)
class PackageResult:
    zip_bytes: bytes
    zip_sha256: str
    manifest: dict
    files: tuple


def export_sheet_svg(parts, stock, placements, *, title="", labels=None):
    return f'<svg xmlns="http://www.w3.org/2000/svg"><title>{title}</title><!-- {len(placements)} --></svg>'


def build_package(batch_id, groups, *, chord_tolerance_mm, context, created_at, versions=None, product_labels=None):
    files = []
    number = 0
    for g in groups:
        for placements in g.outcome.sheets:
            number += 1
            stem = f"batch-{batch_id}-sheet-{number:03d}-{g.stock.width_mm:g}x{g.stock.height_mm:g}mm"
            dxf = f"0\nSECTION\n{len(placements)}\n0\nEOF\n".encode()
            svg = export_sheet_svg(g.parts, g.stock, placements, title=stem).encode()
            files.append(PackageFile(f"{stem}.dxf", "dxf", dxf, hashlib.sha256(dxf).hexdigest(), g.group_key, number))
            files.append(PackageFile(f"{stem}.svg", "svg", svg, hashlib.sha256(svg).hexdigest(), g.group_key, number))
    manifest = {"batch_id": batch_id, "sheets": number, "context": context}
    mbytes = json.dumps(manifest, default=str).encode()
    all_files = (PackageFile("manifest.json", "manifest", mbytes, hashlib.sha256(mbytes).hexdigest()), *files)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for f in all_files:
            zf.writestr(f.name, f.content)
    data = buf.getvalue()
    return PackageResult(data, hashlib.sha256(data).hexdigest(), manifest, all_files)


def install(monkeypatch) -> None:
    """Install the stub as artwork_service.{nesting,nesting_types,validation,dxf_export}."""
    import artwork_service

    this = sys.modules[__name__]
    calls.clear()
    for name in ("nesting", "nesting_types", "validation", "dxf_export"):
        module = types.ModuleType(f"artwork_service.{name}")
        module.__dict__.update({k: getattr(this, k) for k in dir(this) if not k.startswith("__")})
        monkeypatch.setitem(sys.modules, f"artwork_service.{name}", module)
        monkeypatch.setattr(artwork_service, name, module, raising=False)
