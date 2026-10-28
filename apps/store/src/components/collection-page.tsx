import { Link } from "@tanstack/react-router";
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
import { useCategories, type ProductCatalog } from "@/lib/commerce";
import { CollectionLink } from "./collection-link";
import { CategoryDirectory } from "./category-directory";
import { collectionGroup } from "@/lib/taxonomy";
import { groupLabel } from "@/lib/taxonomy-copy";
import type { CollectionSearch } from "@/lib/collection-search";
import { localizedCategoryDescription } from "@/lib/category-copy";

const materials: Material[] = ["wood", "fabric", "metal", "glass"];
export function CollectionPage({
  data,
  search,
  onSearchChange,
}: {
  data: ProductCatalog;
  search: CollectionSearch;
  onSearchChange: (search: CollectionSearch) => void;
}) {
  const { categories, status } = useCategories();
  const { products: visible, productStatus, cursor, errorCode } = data;
  const categoryIds = categories.map((category) => category.id);
  const selectedCategory = categories.find(
    (category) => category.id === search.category,
  );
  const navigate = ({ search }: { search: CollectionSearch }) =>
    onSearchChange(search);
  const group = selectedCategory
    ? collectionGroup(selectedCategory.id)
    : undefined;
  const [filtersOpen, setFiltersOpen] = useState(false);
  return (
    <SiteShell>
      <div className="page-container">
        <nav className="breadcrumb" aria-label={m.home()}>
          <Link to="/">{m.home()}</Link>
          <span>/</span>
          <Link to="/collection" search={{}}>
            {m.collection()}
          </Link>
          {group && (
            <>
              <span>/</span>
              <Link to="/categories/$category" params={{ category: group }}>
                {groupLabel(group)}
              </Link>
            </>
          )}
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
        {!search.category &&
          !search.q &&
          !search.material &&
          !search.cursor && <CategoryDirectory collections={categories} />}
        {selectedCategory?.imageUrl && (
          <figure className="collection-cover">
            <img
              src={selectedCategory.image?.detail || selectedCategory.imageUrl}
              srcSet={selectedCategory.image?.srcSet}
              sizes="(max-width: 700px) 100vw, 60vw"
              width={selectedCategory.image?.width}
              height={selectedCategory.image?.height}
              alt={
                selectedCategory.imageAlt || categoryLabel(selectedCategory.id)
              }
              fetchPriority="high"
            />
          </figure>
        )}
        <h2 className="catalog-products-heading">
          {search.category ? m.collection_filtered_title() : m.all_pieces()}
        </h2>
        <div className="collection-category-bar">
          <nav className="collection-tabs" aria-label={m.collection()}>
            <CollectionLink
              search={{
                category: undefined,
                material: search.material,
                sort: search.sort,
                q: search.q,
              }}
              data-current={!search.category ? "true" : undefined}
            >
              {m.all_pieces()}
            </CollectionLink>
            {categoryIds.map((id) => (
              <CollectionLink
                key={id}
                search={{ ...search, category: id, cursor: undefined }}
                data-current={search.category === id ? "true" : undefined}
              >
                {categoryLabel(id)}
              </CollectionLink>
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
            <h2>{m.collection_empty()}</h2>
            <p>{m.collection_empty_body()}</p>
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
              <CollectionLink
                className="text-link"
                search={{ ...search, cursor: undefined }}
              >
                {m.first_page()}
              </CollectionLink>
            )}
            {cursor && (
              <CollectionLink
                className="moris-button"
                search={{ ...search, cursor }}
              >
                {m.next_page()}
                <ArrowUpRight size={18} />
              </CollectionLink>
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
