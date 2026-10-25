#!/usr/bin/env node
// Independent read-back check of an exported batch package, using the
// third-party `dxf-parser` reader (not the Python exporter's parser or ezdxf).
//
//   node verify-dxf.mjs <package-dir>
//
// <package-dir> holds manifest.json and the sheet DXFs (an extracted ZIP).
// For every sheet in the manifest it checks: the file's SHA-256 matches the
// manifest, $INSUNITS = 4 (mm), every entity is a closed, zero-width,
// bulge-free LWPOLYLINE on layer 0, nothing is defined inside blocks, the
// exterior (CCW) and hole (CW) loop counts equal the placed parts' contour
// counts, the signed area equals the placed metal area, every vertex lies
// in the usable sheet area, the overall bounds equal the placed parts'
// bounds, and each placement's transformed bounding box is reproduced by
// exterior loops inside it. Prints a JSON report; exits 1 on any failure.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const DxfParser = require("dxf-parser");

const EPS = 1e-6;

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Bounds of a part (bbox at the origin, w × h) after the contract transform. */
function placedBounds(width, height, rotation, tx, ty) {
  switch (rotation) {
    case 0:
      return [tx, ty, tx + width, ty + height];
    case 90:
      return [tx - height, ty, tx, ty + width];
    case 180:
      return [tx - width, ty - height, tx, ty];
    case 270:
      return [tx, ty - width, tx + height, ty];
    default:
      return null;
  }
}

function loopBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return [minX, minY, maxX, maxY];
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function perimeter(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function contains(outer, inner, tol) {
  return (
    inner[0] >= outer[0] - tol &&
    inner[1] >= outer[1] - tol &&
    inner[2] <= outer[2] + tol &&
    inner[3] <= outer[3] + tol
  );
}

function sameBounds(a, b, tol) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

function union(boxes) {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

function checkSheet(dir, manifest, sheet, partsByInstance, groupsByKey) {
  const errors = [];
  const tol = manifest.export.chord_tolerance_mm + EPS;
  const data = readFileSync(join(dir, sheet.dxf.filename));
  const sha = createHash("sha256").update(data).digest("hex");
  if (sha !== sheet.dxf.sha256) errors.push(`SHA-256 ${sha} differs from the manifest ${sheet.dxf.sha256}`);

  let dxf;
  try {
    dxf = new DxfParser().parseSync(data.toString("utf8"));
  } catch (err) {
    return { errors: [`dxf-parser could not read the file: ${err.message}`] };
  }
  const insunits = dxf.header?.$INSUNITS;
  if (insunits !== 4) errors.push(`$INSUNITS is ${insunits}, expected 4 (mm)`);

  for (const [name, block] of Object.entries(dxf.blocks ?? {})) {
    if (block.entities?.length) errors.push(`block ${name} defines ${block.entities.length} entities`);
  }

  const loops = [];
  for (const entity of dxf.entities ?? []) {
    const id = entity.handle ?? "?";
    if (entity.type !== "LWPOLYLINE") {
      errors.push(`entity ${id} is ${entity.type}, only LWPOLYLINE is allowed`);
      continue;
    }
    if (entity.layer !== "0") errors.push(`entity ${id} is on layer ${JSON.stringify(entity.layer)}`);
    if (!entity.shape) errors.push(`LWPOLYLINE ${id} is not closed`);
    if (entity.width) errors.push(`LWPOLYLINE ${id} has constant width ${entity.width}`);
    const vertices = entity.vertices ?? [];
    if (vertices.some((v) => v.bulge)) errors.push(`LWPOLYLINE ${id} has arc bulges`);
    if (vertices.some((v) => v.startWidth || v.endWidth)) errors.push(`LWPOLYLINE ${id} has vertex widths`);
    if (vertices.length < 3) {
      errors.push(`LWPOLYLINE ${id} has ${vertices.length} vertices`);
      continue;
    }
    loops.push({ points: vertices, bounds: loopBounds(vertices), area: signedArea(vertices) });
  }

  const group = groupsByKey.get(sheet.group_key);
  const stock = group.stock;
  const usable = [
    stock.margins_mm.left,
    stock.margins_mm.bottom,
    stock.width_mm - stock.margins_mm.right,
    stock.height_mm - stock.margins_mm.top,
  ];

  let expectedExteriors = 0;
  let expectedHoles = 0;
  let expectedArea = 0;
  const placementBoxes = [];
  for (const p of sheet.placements) {
    const part = partsByInstance.get(p.instance_id);
    if (!part) {
      errors.push(`placement ${p.instance_id} is not a manifest instance`);
      continue;
    }
    if (!part.allowed_rotations.includes(p.rotation_deg)) {
      errors.push(`placement ${p.instance_id} uses rotation ${p.rotation_deg}, not allowed`);
    }
    const box = placedBounds(part.width_mm, part.height_mm, p.rotation_deg, p.tx_mm, p.ty_mm);
    if (!box) {
      errors.push(`placement ${p.instance_id} has unsupported rotation ${p.rotation_deg}`);
      continue;
    }
    if (!contains(usable, box, EPS)) errors.push(`placement ${p.instance_id} leaves the usable sheet area`);
    placementBoxes.push({ id: p.instance_id, box, part });
    expectedExteriors += part.exterior_count;
    expectedHoles += part.hole_count;
    expectedArea += part.metal_area_mm2;
  }

  const exteriors = loops.filter((l) => l.area > 0);
  const holes = loops.filter((l) => l.area < 0);
  if (exteriors.length !== expectedExteriors) {
    errors.push(`${exteriors.length} exterior (CCW) loops, expected ${expectedExteriors}`);
  }
  if (holes.length !== expectedHoles) errors.push(`${holes.length} hole (CW) loops, expected ${expectedHoles}`);

  const outside = loops.filter((l) => !contains(usable, l.bounds, EPS)).length;
  if (outside) errors.push(`${outside} loops have vertices outside the usable sheet area`);

  const area = loops.reduce((sum, l) => sum + l.area, 0);
  // Simplification moves each boundary by at most the chord tolerance.
  const areaTol = loops.reduce((sum, l) => sum + perimeter(l.points), 0) * tol + 1e-3;
  if (Math.abs(area - expectedArea) > areaTol) {
    errors.push(`signed loop area ${area.toFixed(3)} mm² differs from placed metal area ${expectedArea.toFixed(3)} mm²`);
  }

  let bounds = null;
  if (loops.length && placementBoxes.length) {
    bounds = union(loops.map((l) => l.bounds));
    const expected = union(placementBoxes.map((p) => p.box));
    if (!sameBounds(bounds, expected, tol)) {
      errors.push(`DXF bounds ${bounds.map((v) => v.toFixed(3))} differ from layout ${expected.map((v) => v.toFixed(3))}`);
    }
  }

  // Each placement must be reproduced where the layout says: the exterior
  // loops lying inside its transformed box together span exactly that box.
  let unmatched = 0;
  for (const { id, box, part } of placementBoxes) {
    const inside = exteriors.filter((l) => contains(box, l.bounds, tol));
    if (inside.length < part.exterior_count || !sameBounds(union(inside.map((l) => l.bounds)), box, tol)) {
      unmatched += 1;
      if (unmatched <= 5) errors.push(`placement ${id} is not reproduced by the DXF loops at its transform`);
    }
  }
  if (unmatched > 5) errors.push(`${unmatched - 5} more placements are not reproduced`);

  return {
    errors,
    insunits,
    layers: [...new Set((dxf.entities ?? []).map((e) => e.layer))],
    entities: (dxf.entities ?? []).length,
    exterior_loops: exteriors.length,
    hole_loops: holes.length,
    placements: sheet.placements.length,
    metal_area_mm2: Number(area.toFixed(3)),
    bounds,
  };
}

function main() {
  const dir = process.argv[2];
  if (!dir) fail("usage: node verify-dxf.mjs <package-dir>");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const partsByInstance = new Map();
  const groupsByKey = new Map();
  for (const group of manifest.groups) {
    groupsByKey.set(group.group_key, group);
    for (const part of group.parts) for (const id of part.instance_ids) partsByInstance.set(id, part);
  }
  const seen = new Set();
  const report = { reader: `dxf-parser@${require("dxf-parser/package.json").version}`, sheets: [], errors: [] };
  for (const sheet of manifest.sheets) {
    const result = checkSheet(dir, manifest, sheet, partsByInstance, groupsByKey);
    report.sheets.push({ sheet_number: sheet.sheet_number, file: sheet.dxf.filename, ...result });
    for (const p of sheet.placements) {
      if (seen.has(p.instance_id)) report.errors.push(`instance ${p.instance_id} is placed more than once`);
      seen.add(p.instance_id);
    }
  }
  const missing = [...partsByInstance.keys()].filter((id) => !seen.has(id));
  if (missing.length) report.errors.push(`${missing.length} manifest instances are on no sheet`);
  if (seen.size !== manifest.counts.placed) {
    report.errors.push(`${seen.size} instances on sheets, manifest counts ${manifest.counts.placed}`);
  }
  report.instances = seen.size;
  report.valid = report.errors.length === 0 && report.sheets.every((s) => s.errors.length === 0);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.valid ? 0 : 1);
}

main();
