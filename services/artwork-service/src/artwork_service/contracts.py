"""Versioned request contracts for the HTTP API (see CONTRACT.md).

Requests are validated strictly (unknown fields rejected, numeric bounds
enforced on the server). Responses are plain JSON built by the handlers in the
shapes documented in CONTRACT.md.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

IdStr = Annotated[str, StringConstraints(min_length=1, max_length=200)]
MAX_PRODUCTS = 50
MAX_LINES = 200
MAX_INSTANCES = 5000
ALLOWED_ROTATIONS = (0, 90, 180, 270)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceSnapshot(Strict):
    gallery_index: Literal[0] = 0
    source_identity: str = Field(min_length=1, max_length=500)
    source_version: str | None = Field(default=None, max_length=500)
    original_url: str = Field(min_length=8, max_length=4000)
    width: int | None = Field(default=None, gt=0, le=100_000)
    height: int | None = Field(default=None, gt=0, le=100_000)


class PrepareProduct(Strict):
    product_id: IdStr
    product_revision: int | None = Field(default=None, ge=0)
    name: str | None = Field(default=None, max_length=500)
    slug: str | None = Field(default=None, max_length=500)
    # Additive: the catalog thumbnail the admin showed, kept with the trace job for history.
    thumbnail_url: str | None = Field(default=None, min_length=8, max_length=4000, pattern=r"^https?://")
    source: SourceSnapshot | None


class PrepareRequest(Strict):
    products: list[PrepareProduct] = Field(min_length=1, max_length=MAX_PRODUCTS)
    reprocess: bool = False

    @model_validator(mode="after")
    def unique_products(self) -> "PrepareRequest":
        ids = [p.product_id for p in self.products]
        if len(ids) != len(set(ids)):
            raise ValueError("product_id values must be unique")
        return self


class StatusProduct(Strict):
    product_id: IdStr
    source_identity: str | None = Field(default=None, max_length=500)
    source_version: str | None = Field(default=None, max_length=500)


class StatusRequest(Strict):
    products: list[StatusProduct] = Field(min_length=1, max_length=MAX_PRODUCTS)


class SizeRequest(Strict):
    mode: Literal["width", "height", "fit"]
    width_mm: float | None = Field(default=None, gt=0, le=20_000)
    height_mm: float | None = Field(default=None, gt=0, le=20_000)


class BatchLine(Strict):
    line_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    product_id: IdStr
    master_id: IdStr
    size: SizeRequest
    quantity: int = Field(gt=0, le=MAX_INSTANCES)
    material: str = Field(min_length=1, max_length=100)
    thickness_mm: float = Field(gt=0, le=100)
    allowed_rotations: list[int] = Field(default_factory=lambda: list(ALLOWED_ROTATIONS), min_length=1, max_length=4)
    variant_id: str | None = Field(default=None, max_length=200)

    @field_validator("allowed_rotations")
    @classmethod
    def quarter_turns(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value) or any(r not in ALLOWED_ROTATIONS for r in value):
            raise ValueError("allowed_rotations must be distinct values from 0, 90, 180, 270")
        return sorted(value)

    @field_validator("material")
    @classmethod
    def trimmed(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("material must not be blank")
        return value


class Margins(Strict):
    left: float = Field(ge=0, le=5_000)
    right: float = Field(ge=0, le=5_000)
    bottom: float = Field(ge=0, le=5_000)
    top: float = Field(ge=0, le=5_000)


class Stock(Strict):
    width_mm: float = Field(gt=0, le=20_000)
    height_mm: float = Field(gt=0, le=20_000)
    margins_mm: Margins
    gap_mm: float = Field(ge=0, le=1_000)
    max_sheets: int = Field(gt=0, le=500)
    label: str | None = Field(default=None, max_length=200)


class Optimization(Strict):
    time_budget_s: Literal[10, 30, 120] = 30
    seed: int = Field(default=0, ge=0, le=2**31 - 1)


class ExportSettings(Strict):
    chord_tolerance_mm: float = Field(default=0.05, ge=0.001, le=1.0)


class BatchRequest(Strict):
    name: str | None = Field(default=None, max_length=200)
    lines: list[BatchLine] = Field(min_length=1, max_length=MAX_LINES)
    stock: Stock
    optimization: Optimization = Field(default_factory=Optimization)
    export: ExportSettings = Field(default_factory=ExportSettings)

    @model_validator(mode="after")
    def totals(self) -> "BatchRequest":
        ids = [line.line_id for line in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("line_id values must be unique")
        total = sum(line.quantity for line in self.lines)
        if total > MAX_INSTANCES:
            raise ValueError(f"a batch may contain at most {MAX_INSTANCES} instances (requested {total})")
        return self
