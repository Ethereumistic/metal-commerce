"""Qualification on the owner's three real product photos.

Records vertex/hole/component counts, runtime and memory for each fixture
(printed with `pytest -s`, and summarized in docs/real-fixture-qualification.md).
Topology floors come from inspecting the overlays; they guard against
regressions that drop holes or split the part.
"""

from __future__ import annotations

import hashlib
import json
import resource
import time
import tracemalloc

import pytest
import shapely

from artwork_service import geometry as geo
from artwork_service.tracing import trace_image

from conftest import REAL

pytestmark = pytest.mark.real

EXPECTED = {
    # name: (sha256, components, min holes, aspect ratio w/h)
    "flower": ("def78de96f66e7076fff7a983bb04ef3d79908ceff0a46235ddf859e41a1b5da", 1, 22, 0.919),
    "trees": ("a420e83b85c321b3c04bcd3d454f7fa27f7b26353dac6bd080b1568ff17d8d69", 1, 120, 2.55),
    "motorcycle": ("74613ebc7769d727e374b107cab268a166d8d7959224ec0ff99f616b4882b7e4", 3, 180, 1.433),
}


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_real_fixture_traces_to_verified_master(name: str) -> None:
    sha, components, min_holes, aspect = EXPECTED[name]
    data = (REAL / f"{name}.png").read_bytes()
    assert hashlib.sha256(data).hexdigest() == sha, "fixture bytes changed"

    tracemalloc.start()
    started = time.perf_counter()
    result = trace_image(data)
    runtime = time.perf_counter() - started
    _, peak_traced = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    g = result.geometry
    assert shapely.is_valid(g)
    assert len(result.components) == components
    assert result.holes >= min_holes
    assert result.aspect_ratio == pytest.approx(aspect, rel=0.01)
    assert g.bounds[0] == pytest.approx(0) and g.bounds[1] == pytest.approx(0)
    assert max(g.bounds[2], g.bounds[3]) == pytest.approx(1.0)
    assert result.diagnostics["refinement"]["method"] == "grayscale-supersampled"
    codes = {w["code"] for w in result.diagnostics["warnings"]}
    assert not codes & {"REFINEMENT_FALLBACK", "PINCH_POINTS_SPLIT", "HOLES_THRESHOLD_SENSITIVE"}
    # Every hole lies inside its own component; islands are separate components.
    for poly in g.geoms:
        for ring in poly.interiors:
            assert poly.exterior.contains(ring) or shapely.Polygon(poly.exterior).contains(shapely.Polygon(ring))

    metrics = {
        "fixture": name,
        "components": len(result.components),
        "islands_in_holes": sum(1 for c in result.components if c["island_of"]),
        "holes": result.holes,
        "vertex_count": result.vertex_count,
        "vertex_count_check": geo.vertex_count(g),
        "aspect_ratio": round(result.aspect_ratio, 4),
        "threshold": result.diagnostics["threshold"],
        "warnings": sorted(codes),
        "runtime_s": round(runtime, 2),
        "peak_python_alloc_mb": round(peak_traced / 2**20, 1),
        "process_peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "svg_bytes": len(result.svg),
    }
    print("\nREAL-FIXTURE " + json.dumps(metrics, sort_keys=True))
