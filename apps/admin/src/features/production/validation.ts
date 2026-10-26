import { LIMITS, THICKNESS_CEILINGS_MM, batchLimitProblems, quantityProblem } from "./batch-logic";
import type { Master } from "./contracts";
import { actualSize } from "./sizing";
import type { BatchLine, SheetSettings } from "./store";

// What the operator must fix before the service is asked to validate a
// batch, each problem tied to the field that fixes it so the UI can jump
// there.

export type LineField = "width" | "height" | "quantity" | "material" | "thickness" | "rotations";
export type SheetField = "width" | "height" | "margins" | "left" | "right" | "bottom" | "top" | "gap" | "maxSheets";

export type LineIssue = { field: LineField | null; message: string };

export function lineIssues(line: BatchLine, aspectRatio: number | null): LineIssue[] {
  const issues: LineIssue[] = [];
  if (aspectRatio == null) issues.push({ field: null, message: "Master not loaded yet." });
  else if (!actualSize(aspectRatio, line))
    issues.push({ field: line.mode === "height" ? "height" : "width", message: "Enter the size." });
  const quantity = quantityProblem(line.quantity);
  if (quantity) issues.push({ field: "quantity", message: quantity });
  if (!line.material) issues.push({ field: "material", message: "Choose a material." });
  if (!line.thickness || line.thickness <= 0)
    issues.push({ field: "thickness", message: "Enter the sheet thickness." });
  else if (line.material && line.thickness > (THICKNESS_CEILINGS_MM[line.material] ?? Infinity))
    issues.push({
      field: "thickness",
      message: `${line.thickness} mm exceeds the current machine's ${THICKNESS_CEILINGS_MM[line.material]} mm ${line.material.toLowerCase()} ceiling.`,
    });
  if (!line.rotations.length) issues.push({ field: "rotations", message: "Allow at least one rotation." });
  return issues;
}

export type BatchIssue = { lineId: string; productName: string; issue: LineIssue };

/** Every line problem in row order, then batch-wide limits, using the masters already loaded. */
export function batchIssues(lines: readonly BatchLine[], masters: Record<string, Master>): BatchIssue[] {
  const rows = lines.flatMap((line) =>
    lineIssues(line, masters[line.masterId]?.aspect_ratio ?? null).map((issue) => ({
      lineId: line.lineId,
      productName: line.productName,
      issue,
    })),
  );
  const limits = batchLimitProblems(lines).map((problem): BatchIssue => {
    const line = lines.find((entry) => entry.lineId === problem.lineId) ?? lines[0];
    return {
      lineId: line?.lineId ?? "",
      productName: line?.productName ?? "Batch",
      issue: { field: problem.lineId ? "quantity" : null, message: problem.message },
    };
  });
  return [...rows, ...limits];
}

/** Number of rows with at least one problem (a cheap store selector). */
export function invalidLineCount(lines: readonly BatchLine[], masters: Record<string, Master>) {
  let count = 0;
  for (const line of lines)
    if (lineIssues(line, masters[line.masterId]?.aspect_ratio ?? null).length) count += 1;
  // A batch over its total limit needs attention even when every row is valid.
  return count || (batchLimitProblems(lines).length ? 1 : 0);
}

export type Usable = { width: number; height: number };

export function usableArea(sheet: SheetSettings): Usable | null {
  const { left, right, bottom, top } = sheet.margins;
  if (left == null || right == null || bottom == null || top == null) return null;
  return { width: sheet.width - left - right, height: sheet.height - bottom - top };
}

export type SheetIssue = { field: SheetField | null; message: string };

export function sheetIssues(sheet: SheetSettings): SheetIssue[] {
  const issues: SheetIssue[] = [];
  const missing = (["left", "right", "bottom", "top"] as const).find((side) => sheet.margins[side] == null);
  if (missing)
    issues.push(
      sheet.linkMargins
        ? { field: "margins", message: "Enter the sheet margin (0 is allowed, but must be entered)." }
        : { field: missing, message: "Enter all four sheet margins (0 is allowed, but must be entered)." },
    );
  if (sheet.gap == null) issues.push({ field: "gap", message: "Enter the minimum gap between parts." });
  if (!sheet.maxSheets || !Number.isInteger(sheet.maxSheets) || sheet.maxSheets < 1 || sheet.maxSheets > LIMITS.maxSheets)
    issues.push({
      field: "maxSheets",
      message: `Sheets per material group must be a whole number from 1 to ${LIMITS.maxSheets}.`,
    });
  if (!(sheet.width > 0) || !(sheet.height > 0))
    issues.push({ field: sheet.width > 0 ? "height" : "width", message: "Enter the sheet size." });
  const usable = usableArea(sheet);
  if (usable && (usable.width <= 0 || usable.height <= 0))
    issues.push({
      field: sheet.linkMargins ? "margins" : "left",
      message: "The margins leave no usable area.",
    });
  return issues;
}

/** Whether one part fits the usable area in any allowed orientation (no gap applies to a lone part). */
export function fitsSheet(size: { width: number; height: number }, rotations: number[], usable: Usable) {
  const upright = rotations.some((rotation) => rotation % 180 === 0);
  const turned = rotations.some((rotation) => rotation % 180 !== 0);
  return (
    (upright && size.width <= usable.width && size.height <= usable.height) ||
    (turned && size.height <= usable.width && size.width <= usable.height)
  );
}
