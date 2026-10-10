import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/home-page";
import { getStoreProducts, type ProductCatalog } from "@/lib/commerce";
import { recordReceipt, receiptExpired } from "@/lib/catalog-freshness";
export const Route = createFileRoute("/")({
  loader: async ({ context, abortController, parentMatchPromise }) => {
    const parent = await parentMatchPromise;
    const result: ProductCatalog =
      parent.loaderData?.errorCode === "SCOPE_MISMATCH"
        ? {
            productStatus: "unavailable",
            products: [],
            cursor: null,
            errorCode: "SCOPE_MISMATCH",
          }
        : await getStoreProducts({
            data: { limit: 4 },
            signal: abortController.signal,
          });
    recordReceipt(context, "/", result);
    return result;
  },
  shouldReload: ({ context }) => receiptExpired(context, "/"),
  staleTime: 30_000,
  preloadStaleTime: 30_000,
  component: HomePage,
});
