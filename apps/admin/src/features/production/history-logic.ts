// Pure helpers for the Production history page. No runtime imports, so
// Node's test runner can load this module directly.

import type { Job } from "./contracts";

/** What this browser remembers about a product (fallback for jobs the service did not name). */
export type LocalProduct = { id: string; name: string | null; thumbnail: string | null };

export type TraceSubject = {
  name: string | null;
  thumbnail: string | null;
  /** Where the identity came from: the job's own snapshot, this browser, or nowhere. */
  source: "job" | "browser" | "unknown";
  /** Products search that finds the product again, for a failed trace. */
  search: string | null;
};

/**
 * Names a trace job by the product it was queued for. The service's snapshot
 * on the job wins, because retrying a product starts a new job and this
 * browser then only remembers the newest one; local data is used only for
 * jobs recorded before the service kept that snapshot.
 */
export function traceSubject(job: Job, local: LocalProduct | null): TraceSubject {
  const recorded = job.product;
  if (recorded) {
    const sameProduct = local?.id === recorded.id ? local : null;
    const name = recorded.name ?? sameProduct?.name ?? recorded.slug;
    return {
      name,
      thumbnail: recorded.thumbnail ?? sameProduct?.thumbnail ?? null,
      source: "job",
      search: name,
    };
  }
  if (local) return { name: local.name, thumbnail: local.thumbnail, source: "browser", search: local.name };
  return { name: null, thumbnail: null, source: "unknown", search: null };
}
