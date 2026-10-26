import type { Batch, Health, JsonValue, ServiceResult, Sheet } from "./contracts";

// Pure rules behind the Results step and the service indicator: sheet
// numbering, what a finished batch does and does not prove, which engine
// produced each group, what is left on the last sheet, the phase of a running
// nest, and how the service's health reads to a person. No runtime imports,
// so node's test runner can load this file directly.

type JsonRecord = { [key: string]: JsonValue };
const asRecord = (value: JsonValue | undefined): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const asNumber = (value: JsonValue | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** Millimetres with at most two decimals and no trailing zeros. */
export function formatMm(value: number) {
  return `${Number(value.toFixed(2))}`;
}

/** An area in m² (the unit people think of sheets in), from mm². */
export function formatArea(mm2: number) {
  const m2 = mm2 / 1e6;
  return `${m2 >= 10 ? m2.toFixed(1) : m2.toFixed(2)} m²`;
}

export function formatPercent(ratio: number) {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** "42 s", "3 min 05 s", "1 h 02 min". */
export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/**
 * The one-based sheet number shown everywhere (tabs, viewport, downloads).
 * The service sends its saved sheet number, which also names the files; a
 * zero-based list (older or other producers) is shifted so the first sheet
 * is always Sheet 1.
 */
export function sheetNumbers(sheets: readonly Pick<Sheet, "sheet_id" | "index">[]): Map<string, number> {
  const zeroBased = sheets.some((sheet) => sheet.index < 1);
  return new Map(sheets.map((sheet, position) => [
    sheet.sheet_id,
    Number.isInteger(sheet.index) ? sheet.index + (zeroBased ? 1 : 0) : position + 1,
  ]));
}

export type EngineKind = "irregular" | "bbox" | "unknown";

export function engineKind(engine: string | null): EngineKind {
  if (!engine) return "unknown";
  if (/bbox|baseline|rect/i.test(engine)) return "bbox";
  if (/irregular|packingsolver/i.test(engine)) return "irregular";
  return "unknown";
}

export const ENGINE_TEXT: Record<EngineKind, { label: string; detail: string }> = {
  irregular: {
    label: "Irregular solver",
    detail: "Parts were nested by their real outlines, so they can sit inside each other's gaps.",
  },
  bbox: {
    label: "Rectangle fallback",
    detail:
      "The irregular solver did not produce a better valid layout in time, so parts were placed by their bounding rectangles. Expect more offcut; a longer time budget may help.",
  },
  unknown: { label: "Engine not reported", detail: "The service did not say which engine placed this group." },
};

export type GroupSummary = {
  groupKey: string;
  label: string;
  sheetNumbers: number[];
  requested: number | null;
  placed: number;
  unplaced: number | null;
  engine: EngineKind;
  engineVersion: string | null;
  runtimeS: number | null;
  /** Sheet area not covered by parts, across the group's sheets (offcut, not reusable stock). */
  unusedAreaMm2: number | null;
  /** Usable area outside the occupied box, summed over the group's sheets (reusable stock); null from older services. */
  usableLeftoverMm2: number | null;
  /** Free strip at the far end of the group's last sheet, across the full usable width. */
  remnant: { widthMm: number; lengthMm: number } | null;
};

/** Smallest strip worth calling usable leftover stock. */
export const MIN_REMNANT_MM = 50;

function stockOf(request: Batch["request"]) {
  const stock = asRecord(request.stock);
  const margins = asRecord(stock?.margins_mm);
  const width = asNumber(stock?.width_mm);
  const height = asNumber(stock?.height_mm);
  if (width == null || height == null) return null;
  return {
    width,
    height,
    left: asNumber(margins?.left) ?? 0,
    right: asNumber(margins?.right) ?? 0,
    bottom: asNumber(margins?.bottom) ?? 0,
    top: asNumber(margins?.top) ?? 0,
    gap: asNumber(stock?.gap_mm) ?? 0,
    maxSheets: asNumber(stock?.max_sheets),
  };
}

/**
 * Per material group: which engine placed it, how much of the sheet area is
 * unused, and the clean strip left at the end of the last sheet. The strip is
 * measured from the occupied extent the service reports along the sheet's
 * long axis, less one part gap.
 */
export function groupSummaries(batch: Batch): GroupSummary[] {
  const numbers = sheetNumbers(batch.sheets);
  const outcomes = asRecord(batch.totals?.groups ?? null);
  const extents = asRecord(batch.totals?.occupied_extent_by_group_mm ?? null);
  const usable = asRecord(batch.totals?.leftover_usable_area_by_group_mm2 ?? null);
  const stock = stockOf(batch.request);
  const keys = [
    ...new Set([...batch.groups.map((group) => group.group_key), ...batch.sheets.map((sheet) => sheet.group_key)]),
  ];
  return keys.map((key) => {
    const group = batch.groups.find((entry) => entry.group_key === key);
    const sheets = batch.sheets.filter((sheet) => sheet.group_key === key);
    const outcome = asRecord(outcomes?.[key]);
    const metrics = asRecord(outcome?.metrics);
    const placed = sheets.reduce((sum, sheet) => sum + sheet.placements.length, 0);
    const extent = asNumber(extents?.[key]);
    let remnant: GroupSummary["remnant"] = null;
    if (stock && extent != null && sheets.length) {
      const alongY = stock.height >= stock.width;
      const usableLength = alongY ? stock.height - stock.bottom - stock.top : stock.width - stock.left - stock.right;
      const usableWidth = alongY ? stock.width - stock.left - stock.right : stock.height - stock.bottom - stock.top;
      const length = Math.max(0, usableLength - extent - stock.gap);
      remnant = { widthMm: Math.max(0, usableWidth), lengthMm: length };
    }
    return {
      groupKey: key,
      label: group ? `${group.material} · ${formatMm(group.thickness_mm)} mm` : key,
      sheetNumbers: sheets.map((sheet) => numbers.get(sheet.sheet_id) ?? 0),
      requested: group?.instance_count ?? asNumber(metrics?.requested),
      placed,
      unplaced: asNumber(outcome?.unplaced),
      engine: engineKind(typeof outcome?.engine === "string" ? outcome.engine : null),
      engineVersion: typeof outcome?.engine_version === "string" ? outcome.engine_version : null,
      runtimeS: asNumber(outcome?.runtime_s),
      unusedAreaMm2: asNumber(metrics?.unused_area_mm2),
      usableLeftoverMm2: asNumber(usable?.[key]) ?? asNumber(metrics?.leftover_usable_area_mm2),
      remnant,
    };
  });
}

/** Plain-language leftover for one group. */
export function leftoverText(summary: GroupSummary): string {
  const parts: string[] = [];
  if (summary.remnant && summary.remnant.lengthMm >= MIN_REMNANT_MM)
    parts.push(
      `The last sheet has a clear strip of about ${Math.floor(summary.remnant.widthMm)} × ${Math.floor(summary.remnant.lengthMm)} mm (${formatArea(summary.remnant.widthMm * summary.remnant.lengthMm)}) after the last part.`,
    );
  else if (summary.remnant) parts.push("The last sheet is used to its far end; no clear strip is left.");
  return parts.join(" ");
}

export type LeftoverSummary = {
  /** Reusable stock: usable area outside the occupied box on each sheet, summed (null when not reported). */
  usableMm2: number | null;
  /** Every part of the sheets not covered by parts, gaps between parts included. */
  metalFreeMm2: number | null;
};

export const USABLE_LEFTOVER_DEFINITION =
  "The clear strip beyond the parts plus the free side column on every sheet: usable sheet area outside the box that runs from the usable corner to the farthest part, plus one gap. It can be cut later as offcut stock.";
export const METAL_FREE_DEFINITION =
  "All sheet area not covered by parts, including the gaps between them, which is mostly scrap.";

/**
 * The batch's leftover in two separate figures, so reusable offcut is never
 * confused with the scrap between parts. Usable leftover comes from the
 * service (totals, else the groups' own figures); metal-free area is the
 * sheet area less the metal placed.
 */
export function leftoverSummary(batch: Batch, groups: readonly GroupSummary[]): LeftoverSummary {
  const totals = batch.totals;
  if (!totals || !batch.sheets.length) return { usableMm2: null, metalFreeMm2: null };
  const groupUsable = groups.map((group) => group.usableLeftoverMm2);
  const usableMm2 =
    totals.leftover_usable_area_mm2 ??
    (groupUsable.length && groupUsable.every((value) => value != null)
      ? groupUsable.reduce<number>((sum, value) => sum + value!, 0)
      : null);
  return { usableMm2, metalFreeMm2: Math.max(0, totals.sheet_area_mm2 - totals.metal_area_mm2) };
}

export type CheckState = "good" | "attention" | "blocked" | "pending";

export type Qualification = {
  geometry: { state: CheckState; title: string; detail: string };
  features: { state: CheckState; title: string; detail: string; lineIds: string[] };
  /** True only when geometry is complete and every feature check passed. */
  readyToCut: boolean;
};

/**
 * What a batch result proves. Geometry (every part placed, layout and DXF
 * checked by the service) is separate from process qualification (feature
 * widths and holes against the fabrication profile); an unknown check is
 * never presented as passed.
 */
export function qualification(batch: Batch): Qualification {
  const totals = batch.totals;
  let geometry: Qualification["geometry"];
  if (batch.status === "completed")
    geometry = {
      state: "good",
      title: "Geometry complete",
      detail: totals
        ? `All ${plural(totals.placed, "part")} placed on ${plural(totals.sheet_count, "sheet")}; the layout and DXF files passed the service's independent checks.`
        : "The layout and DXF files passed the service's independent checks.",
    };
  else if (batch.status === "incomplete")
    geometry = {
      state: "blocked",
      title: "Not every part was placed",
      detail: totals
        ? `${plural(totals.unplaced, "part")} of ${totals.requested} did not fit within the sheet limit and time budget. No production files are offered for a partial result.`
        : "Some parts did not fit within the sheet limit and time budget. No production files are offered for a partial result.",
    };
  else if (batch.status === "failed" || batch.status === "cancelled" || batch.status === "invalid")
    geometry = {
      state: "blocked",
      title: batch.status === "cancelled" ? "Nesting was cancelled" : "No layout was produced",
      detail: batch.error?.message ?? "Nothing was exported.",
    };
  else geometry = { state: "pending", title: "Nesting not finished", detail: "Results appear when the job completes." };

  const checks = batch.lines.map((line) => ({ lineId: line.line_id, check: line.feature_check }));
  const failed = checks.filter((entry) => entry.check?.status === "fail");
  const unknown = checks.filter((entry) => !entry.check || entry.check.status === "unknown");
  let features: Qualification["features"];
  if (!checks.length)
    features = {
      state: "attention",
      title: "Feature widths not reported",
      detail: "The service did not report feature checks for this batch. Inspect thin bridges and small holes before cutting.",
      lineIds: [],
    };
  else if (failed.length)
    features = {
      state: "blocked",
      title: `${plural(failed.length, "part")} below the fabrication limits`,
      detail: failed[0]!.check!.message || "Some features are thinner than the fabrication profile allows.",
      lineIds: failed.map((entry) => entry.lineId),
    };
  else if (unknown.length)
    features = {
      state: "attention",
      title: "Feature widths not qualified",
      detail:
        unknown.find((entry) => entry.check?.message)?.check?.message ||
        "Thin bridges and small holes were not checked against the cutting process. Inspect them before cutting.",
      lineIds: unknown.map((entry) => entry.lineId),
    };
  else
    features = {
      state: "good",
      title: "Feature widths qualified",
      detail: "Every part's features meet the fabrication profile's minimum widths.",
      lineIds: [],
    };
  return { geometry, features, readyToCut: geometry.state === "good" && features.state === "good" };
}

/** Whether the result failed for lack of sheets (the operator can raise the limit and retry). */
export function shortOfSheets(batch: Batch): boolean {
  if (batch.status !== "incomplete") return false;
  const groups = asRecord(batch.totals?.groups ?? null);
  const limit = stockOf(batch.request)?.maxSheets;
  if (limit == null) return true;
  return batch.groups.some((group) => {
    const used = batch.sheets.filter((sheet) => sheet.group_key === group.group_key).length;
    const unplaced = asNumber(asRecord(groups?.[group.group_key])?.unplaced);
    return used >= limit && (unplaced == null || unplaced > 0);
  });
}

/**
 * A sheet limit that should hold every part next time: per group, the
 * sheets used scaled by requested / placed, plus one spare, at least one
 * more than before, capped at the admin's limit.
 */
export function suggestedSheetLimit(batch: Batch, cap: number): number {
  const current = stockOf(batch.request)?.maxSheets ?? 1;
  let needed = current + 1;
  for (const group of batch.groups) {
    const sheets = batch.sheets.filter((sheet) => sheet.group_key === group.group_key);
    const placed = sheets.reduce((sum, sheet) => sum + sheet.placements.length, 0);
    const estimate = Math.ceil((Math.max(sheets.length, 1) * group.instance_count) / Math.max(placed, 1)) + 1;
    needed = Math.max(needed, estimate);
  }
  return Math.min(cap, needed);
}

export type NestPhase = { key: "queued" | "preparing" | "solving" | "checking" | "exporting" | "finished"; label: string };

export const NEST_PHASES = ["queued", "preparing", "solving", "checking", "exporting"] as const;

/** The phase of a nest job from the service's free-form stage text. */
export function nestPhase(status: string, stage: string | null): NestPhase {
  if (status === "succeeded" || status === "failed" || status === "cancelled") return { key: "finished", label: "Finished" };
  if (status === "queued") return { key: "queued", label: "Waiting for the workshop PC" };
  const text = (stage ?? "").toLowerCase();
  if (text.startsWith("nesting")) {
    const group = /^nesting\s+([^:]+)/.exec(stage ?? "")?.[1]?.trim();
    return { key: "solving", label: group ? `Solving layout for ${group}` : "Solving layout" };
  }
  if (text.startsWith("validat")) return { key: "checking", label: "Checking the layout" };
  if (/export|writ|publish/.test(text)) return { key: "exporting", label: "Writing DXF files" };
  return { key: "preparing", label: "Preparing parts" };
}

export type HealthView = {
  tone: "good" | "busy" | "warn" | "down" | "unknown";
  label: string;
  detail: string | null;
};

/** How long a not-ready worker is called "starting" before it is reported as not responding. */
export const WORKER_GRACE_MS = 90_000;

/** A status check still unanswered after this long is reported as stalled. */
export const STATUS_STALL_MS = 10_000;

/**
 * How fresh the service reading is. `stalled` when the running check has
 * gone unanswered for a while or the last one timed out, so the indicator
 * can say how old its reading is and offer to check again.
 */
export function healthFreshness(
  checkedAtMs: number | null,
  checkingSinceMs: number | null,
  timedOut: boolean,
  nowMs: number,
): { stalled: boolean; text: string } {
  const stalled = timedOut || (checkingSinceMs != null && nowMs - checkingSinceMs >= STATUS_STALL_MS);
  const ago = checkedAtMs == null ? "Not checked yet" : `Last checked ${formatDuration((nowMs - checkedAtMs) / 1000)} ago`;
  return { stalled, text: stalled ? `${ago}. The latest check is not answering.` : `${ago}.` };
}

/**
 * The service indicator's wording. A worker that is not ready while jobs run
 * is busy (a long solve holds its heartbeat), one that just went quiet is
 * starting, and one quiet for longer than the grace period is not responding.
 */
export function describeHealth(
  result: ServiceResult<Health> | null,
  notReadySinceMs: number | null,
  nowMs: number,
): HealthView {
  if (!result) return { tone: "unknown", label: "Checking service…", detail: null };
  if (!result.ok)
    return result.offline
      ? { tone: "down", label: "Workshop PC offline", detail: "The artwork service cannot be reached. Retrying automatically." }
      : { tone: "down", label: "Processing unavailable", detail: `${result.error.code}: ${result.error.message}` };
  const health = result.data;
  const versions = `Service ${health.service_version}, tracer ${health.tracer_version}, solver ${health.solver_version}, exporter ${health.exporter_version}.`;
  const queue =
    health.queue.running || health.queue.queued
      ? `${plural(health.queue.running, "job")} running, ${health.queue.queued} waiting.`
      : "No jobs waiting.";
  if (health.worker_ready) return { tone: "good", label: "Service ready", detail: `${queue} ${versions}` };
  if (health.queue.running > 0)
    return { tone: "busy", label: "Busy with a job", detail: `The worker is occupied by a running job. ${queue} ${versions}` };
  if (notReadySinceMs == null || nowMs - notReadySinceMs < WORKER_GRACE_MS)
    return { tone: "busy", label: "Worker starting", detail: `${queue} ${versions}` };
  return {
    tone: "warn",
    label: "Worker not responding",
    detail: `The service is up but its worker has not checked in for ${formatDuration((nowMs - notReadySinceMs) / 1000)}. New jobs wait until it does. ${versions}`,
  };
}

/**
 * Part colours, one per batch line in request order, used identically in the
 * sheet viewport, the legend and every list. Mid-luminance so they read on
 * both the light and the dark sheet; hazard yellow is deliberately absent.
 */
export const PART_COLOURS = [
  "#3e6fd8",
  "#e07a1f",
  "#2e9d5b",
  "#c2449b",
  "#1c9aa6",
  "#a8801a",
  "#7a5bd6",
  "#b9473a",
] as const;

export const partColour = (index: number) => PART_COLOURS[((index % PART_COLOURS.length) + PART_COLOURS.length) % PART_COLOURS.length]!;
