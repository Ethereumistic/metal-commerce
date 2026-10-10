import type { ProductFilters, CatalogState } from "./commerce";
export interface CatalogRouterContext {
  catalogReceipts: Map<string, number>;
}
export function catalogKey(
  routeId: string,
  filters?: ProductFilters,
  slug?: string,
) {
  if (routeId === "/pieces/$slug") return `${routeId}:${slug}`;
  if (routeId === "/collection") return `${routeId}:${JSON.stringify(filters)}`;
  return routeId;
}
export function recordReceipt(
  context: CatalogRouterContext,
  key: string,
  result: CatalogState,
) {
  // Zero marks a failed load, so navigation may retry without retaining old data.
  context.catalogReceipts.delete(key);
  context.catalogReceipts.set(key, result.loadedAt ?? 0);
  if (context.catalogReceipts.size > 128)
    context.catalogReceipts.delete(
      context.catalogReceipts.keys().next().value!,
    );
}
export function receiptExpired(
  context: CatalogRouterContext,
  key: string,
  ttl = 30_000,
) {
  const received = context.catalogReceipts.get(key);
  return received === undefined ? true : Date.now() - received >= ttl;
}
