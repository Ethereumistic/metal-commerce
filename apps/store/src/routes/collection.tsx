import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { SlidersHorizontal, ArrowUpRight, X } from "lucide-react";
import { useState } from "react";
import { SiteShell } from "@/components/site-shell";
import { PieceCard } from "@/components/piece-card";
import { Button } from "@workspace/ui/components/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@workspace/ui/components/sheet";
import { categoryLabel, materialLabel, type Material } from "@/lib/catalog";
import { m } from "@/paraglide/messages";
import {
  useCategories,
  getStoreProducts,
  validateProductFilters,
  type ProductCatalog,
} from "@/lib/commerce";
import {
  recordReceipt,
  receiptExpired,
  catalogKey,
} from "@/lib/catalog-freshness";
import { localizedCategoryDescription } from "@/lib/category-copy";

type CollectionSearch = {
  category?: string;
  material?: Material;
  sort?: "name";
  q?: string;
  cursor?: string;
};
const materials: Material[] = ["wood", "fabric", "metal", "glass"];
export const Route = createFileRoute("/collection")({
  validateSearch: (search: Record<string, unknown>): CollectionSearch => ({
    category:
      typeof search.category === "string" && search.category.length <= 200
        ? search.category
        : undefined,
    material: materials.includes(search.material as Material)
      ? (search.material as Material)
      : undefined,
    sort: search.sort === "name" && !search.q ? "name" : undefined,
    q: typeof search.q === "string" ? search.q.trim() || undefined : undefined,
    cursor:
      typeof search.cursor === "string" && search.cursor.length <= 8192
        ? search.cursor
        : undefined,
  }),
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
  component: CollectionPage,
});

function CollectionPage() {
  const { categories, status } = useCategories();
  const {
    products: visible,
    productStatus,
    cursor,
    errorCode,
  } = Route.useLoaderData();
  const categoryIds = categories.map((category) => category.id);
  const search = Route.useSearch();
  const selectedCategory = categories.find(
    (category) => category.id === search.category,
  );
  const navigate = Route.useNavigate();
  const [filtersOpen, setFiltersOpen] = useState(false);
  return (
    <SiteShell>
      <div className="page-container">
        <nav className="breadcrumb" aria-label={m.home()}>
          <Link to="/">{m.home()}</Link>
          <span>/</span>
          <span>{m.collection()}</span>
          {search.category && (
            <>
              <span>/</span>
              <span>{categoryLabel(search.category)}</span>
            </>
          )}
        </nav>
        <section className="collection-intro">
          <h1>
            {search.category
              ? categoryLabel(search.category) + "."
              : m.collection_title()}
          </h1>
          <p>
            {search.category
              ? selectedCategory
                ? localizedCategoryDescription(selectedCategory)
                : m.category_not_found()
              : m.collection_intro()}
          </p>
        </section>
        {status !== "ready" && (
          <p role="status">{m.categories_unavailable()}</p>
        )}
        <div className="collection-category-bar">
          <nav className="collection-tabs" aria-label={m.collection()}>
            <Link
              to="/collection"
              search={{
                category: undefined,
                material: search.material,
                sort: search.sort,
                q: search.q,
              }}
              activeOptions={{ exact: true, includeSearch: true }}
              data-current={!search.category ? "true" : undefined}
            >
              {m.all_pieces()}
            </Link>
            {categoryIds.map((id) => (
              <Link
                key={id}
                to="/collection"
                search={{ ...search, category: id, cursor: undefined }}
                activeOptions={{ exact: true, includeSearch: true }}
                data-current={search.category === id ? "true" : undefined}
              >
                {categoryLabel(id)}
              </Link>
            ))}
          </nav>
        </div>
        <div className="collection-toolbar">
          <div className="filter-actions">
            <Button
              variant="ghost"
              className="refine-button"
              onClick={() => setFiltersOpen(true)}
            >
              <SlidersHorizontal size={17} />
              {m.filter()}
              {search.material && <span className="filter-dot" />}
            </Button>
            <span className="piece-count" aria-live="polite">
              {m.pieces_on_page({ count: visible.length })}
            </span>
          </div>
          <div className="sort-control">
            <span>{m.sort()}</span>
            <Select
              disabled={Boolean(search.q)}
              value={search.sort ?? "featured"}
              onValueChange={(value) =>
                void navigate({
                  search: {
                    ...search,
                    cursor: undefined,
                    sort: value === "name" ? "name" : undefined,
                  },
                })
              }
            >
              <SelectTrigger aria-label={m.sort()} className="sort-select">
                <SelectValue>
                  {search.sort === "name" ? m.sort_name() : m.sort_featured()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="featured">{m.sort_featured()}</SelectItem>
                <SelectItem value="name">{m.sort_name()}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {search.q && (
          <div className="active-filters">
            <p>{m.search_results_for({ query: search.q })}</p>
            <Button
              variant="outline"
              onClick={() =>
                void navigate({
                  search: { ...search, q: undefined, cursor: undefined },
                })
              }
            >
              {m.reset()}
              <X size={14} />
            </Button>
          </div>
        )}
        {search.material && (
          <div className="active-filters">
            <Button
              variant="outline"
              onClick={() =>
                void navigate({
                  search: { ...search, material: undefined, cursor: undefined },
                })
              }
            >
              {materialLabel(search.material)}
              <X size={14} />
            </Button>
          </div>
        )}
        {productStatus !== "ready" ? (
          <div className="collection-empty" role="status">
            <p>
              {errorCode === "INVALID_REQUEST"
                ? m.search_refine()
                : m.products_unavailable()}
            </p>
          </div>
        ) : visible.length ? (
          <div className="piece-grid collection-grid">
            {visible.map((piece) => (
              <PieceCard key={piece.slug} piece={piece} />
            ))}
          </div>
        ) : (
          <div className="collection-empty">
            <h2>{m.no_pieces()}</h2>
            <p>{m.no_pieces_body()}</p>
            <Button
              className="moris-button"
              onClick={() =>
                void navigate({
                  search: { ...search, material: undefined, cursor: undefined },
                })
              }
            >
              {m.reset()}
              <ArrowUpRight size={18} />
            </Button>
          </div>
        )}
        {productStatus === "ready" && (
          <nav
            className="collection-pagination"
            aria-label={m.collection_pages()}
          >
            {search.cursor && (
              <Link
                className="text-link"
                to="/collection"
                search={{ ...search, cursor: undefined }}
              >
                {m.first_page()}
              </Link>
            )}
            {cursor && (
              <Link
                className="moris-button"
                to="/collection"
                search={{ ...search, cursor }}
              >
                {m.next_page()}
                <ArrowUpRight size={18} />
              </Link>
            )}
          </nav>
        )}
      </div>
      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent closeLabel={m.close()} className="filter-sheet">
          <SheetHeader>
            <SheetTitle>{m.filter()}</SheetTitle>
            <SheetDescription>{m.filter_material()}</SheetDescription>
          </SheetHeader>
          <div className="material-options">
            <Button
              variant="ghost"
              aria-pressed={!search.material}
              onClick={() =>
                void navigate({
                  search: { ...search, material: undefined, cursor: undefined },
                })
              }
            >
              {m.all_materials()}
              <span className="radio-indicator" />
            </Button>
            {materials.map((material) => (
              <Button
                key={material}
                variant="ghost"
                aria-pressed={search.material === material}
                onClick={() =>
                  void navigate({
                    search: { ...search, material, cursor: undefined },
                  })
                }
              >
                {materialLabel(material)}
                <span className="radio-indicator" />
              </Button>
            ))}
          </div>
          <div className="filter-sheet-footer">
            <Button
              variant="link"
              onClick={() =>
                void navigate({
                  search: { ...search, material: undefined, cursor: undefined },
                })
              }
            >
              {m.reset()}
            </Button>
            <Button
              className="moris-button"
              onClick={() => setFiltersOpen(false)}
            >
              {m.pieces_on_page({ count: visible.length })}
              <ArrowUpRight size={18} />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </SiteShell>
  );
}
