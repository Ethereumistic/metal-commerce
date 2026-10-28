import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { CollectionPage } from "@/components/collection-page";
import {
  collectionSearch,
  type CollectionSearch,
} from "@/lib/collection-search";
import { collectionSlug } from "@/lib/taxonomy";
import { categoryLabel } from "@/lib/catalog";
import { localizedCategoryDescription } from "@/lib/category-copy";
import {
  getStoreProducts,
  validateProductFilters,
  type StoreCategory,
  type ProductCatalog,
} from "@/lib/commerce";
import {
  catalogKey,
  receiptExpired,
  recordReceipt,
} from "@/lib/catalog-freshness";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/collections/$collection")({
  validateSearch: (search): CollectionSearch => ({
    ...collectionSearch(search),
    category: undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({
    params,
    deps,
    context,
    parentMatchPromise,
    abortController,
  }) => {
    const parent = await parentMatchPromise;
    const collection = parent.loaderData?.categories.find(
      (c: StoreCategory) => collectionSlug(c.id) === params.collection,
    );
    if (parent.loaderData?.status === "ready" && !collection) throw notFound();
    let invalid = false;
    try {
      validateProductFilters(deps);
    } catch {
      invalid = true;
    }
    const result: ProductCatalog = invalid
      ? {
          productStatus: "unavailable",
          products: [],
          cursor: null,
          errorCode: "INVALID_REQUEST",
        }
      : collection
        ? await getStoreProducts({
            data: { ...deps, category: collection.id, limit: 24 },
            signal: abortController.signal,
          })
        : {
            productStatus: "unavailable",
            products: [],
            cursor: null,
            errorCode: parent.loaderData?.errorCode,
          };
    if (result.errorCode === "RESTART_PAGINATION" && deps.cursor)
      throw redirect({
        to: "/collections/$collection",
        params,
        search: { ...deps, cursor: undefined },
        replace: true,
      });
    recordReceipt(
      context,
      catalogKey("/collections/$collection", deps, params.collection),
      result,
    );
    return { ...result, collection };
  },
  shouldReload: ({ context, deps, params }) =>
    receiptExpired(
      context,
      catalogKey("/collections/$collection", deps, params.collection),
      deps.q ? 15_000 : 30_000,
    ),
  staleTime: 15_000,
  preloadStaleTime: 15_000,
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.collection ? categoryLabel(loaderData.collection.id) : m.collection_label()} — Metal Craft`,
      },
      {
        name: "description",
        content: loaderData?.collection
          ? localizedCategoryDescription(loaderData.collection)
          : m.collection_intro(),
      },
    ],
  }),
  component: () => {
    const data = Route.useLoaderData();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <CollectionPage
        data={data}
        search={{ ...search, category: data.collection?.id }}
        onSearchChange={({ category: _category, ...filters }) => {
          void navigate({ search: filters });
        }}
      />
    );
  },
});
