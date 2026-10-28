import { createFileRoute, redirect } from "@tanstack/react-router";
import { CollectionPage } from "@/components/collection-page";
import { collectionSearch } from "@/lib/collection-search";
import {
  getStoreProducts,
  validateProductFilters,
  type ProductCatalog,
} from "@/lib/commerce";
import {
  recordReceipt,
  receiptExpired,
  catalogKey,
} from "@/lib/catalog-freshness";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/collection")({
  validateSearch: collectionSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, context, abortController, parentMatchPromise }) => {
    const parent = await parentMatchPromise;
    let result: ProductCatalog;
    if (parent.loaderData?.errorCode === "SCOPE_MISMATCH") {
      result = {
        productStatus: "unavailable",
        products: [],
        cursor: null,
        errorCode: "SCOPE_MISMATCH",
      };
    } else {
      try {
        validateProductFilters(deps);
      } catch {
        result = {
          productStatus: "unavailable",
          products: [],
          cursor: null,
          errorCode: "INVALID_REQUEST",
        };
        recordReceipt(context, catalogKey("/collection", deps), result);
        return result;
      }
      result = await getStoreProducts({
        data: { ...deps, limit: 24 },
        signal: abortController.signal,
      });
    }
    if (result.errorCode === "RESTART_PAGINATION" && deps.cursor)
      throw redirect({
        to: "/collection",
        search: { ...deps, cursor: undefined },
        replace: true,
      });
    recordReceipt(context, catalogKey("/collection", deps), result);
    return result;
  },
  shouldReload: ({ context, deps }) =>
    receiptExpired(
      context,
      catalogKey("/collection", deps),
      deps.q ? 15_000 : 30_000,
    ),
  staleTime: 15_000,
  preloadStaleTime: 15_000,
  head: () => ({
    meta: [
      { title: m.collection() + " — Metal Craft" },
      { name: "description", content: m.collection_intro() },
    ],
  }),
  component: () => {
    const navigate = Route.useNavigate();
    return (
      <CollectionPage
        data={Route.useLoaderData()}
        search={Route.useSearch()}
        onSearchChange={(search) => {
          void navigate({ search });
        }}
      />
    );
  },
});
