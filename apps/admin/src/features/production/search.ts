import { RESOURCE_ID } from "./contracts";

// Studio's URL state for the Production workspace. The job and batch IDs live
// here (and in localStorage) so a reload or a shared link resumes the same
// accepted job instead of submitting a new one.

export const STAGES = ["products", "batch", "sheets", "results"] as const;
export type Stage = (typeof STAGES)[number];

export type StudioSearch = {
  workspace?: "production";
  stage?: Stage;
  job?: string;
  batch?: string;
  /** Product search to open the Products step with (from a history entry). */
  q?: string;
};

const resource = (value: unknown) =>
  typeof value === "string" && RESOURCE_ID.test(value) ? value : undefined;

const query = (value: unknown) =>
  typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : undefined;

export function validateStudioSearch(search: Record<string, unknown>): StudioSearch {
  if (search.workspace !== "production") return {};
  const stage = STAGES.includes(search.stage as Stage) ? (search.stage as Stage) : undefined;
  return {
    ...(query(search.q) ? { q: query(search.q) } : {}),
    workspace: "production",
    ...(stage ? { stage } : {}),
    ...(resource(search.job) ? { job: resource(search.job) } : {}),
    ...(resource(search.batch) ? { batch: resource(search.batch) } : {}),
  };
}
