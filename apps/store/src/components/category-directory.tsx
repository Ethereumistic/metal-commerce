import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import type { StoreCategory } from "@/lib/commerce";
import { categoryLabel } from "@/lib/catalog";
import { localizedCategoryDescription } from "@/lib/category-copy";
import { groupedCollections } from "@/lib/taxonomy";
import { groupDescription, groupLabel } from "@/lib/taxonomy-copy";
import { m } from "@/paraglide/messages";
import { CollectionLink } from "./collection-link";

export function CategoryDirectory({
  collections,
  showHeading = true,
  showGroups = true,
}: {
  collections: StoreCategory[];
  showHeading?: boolean;
  showGroups?: boolean;
}) {
  if (!collections.length) return null;
  const CollectionHeading = showGroups ? "h4" : "h2";
  return (
    <section className="category-directory" aria-label={m.categories()}>
      {showHeading && <h2>{m.browse_categories()}</h2>}
      <div className="category-directory-grid">
        {groupedCollections(collections).map((group) => (
          <section className="category-group" key={group.id}>
            {showGroups && (
              <header>
                <h3>
                  <Link
                    to="/categories/$category"
                    params={{ category: group.id }}
                  >
                    {groupLabel(group.id)}
                    <ArrowUpRight size={24} aria-hidden="true" />
                  </Link>
                </h3>
                <p>{groupDescription(group.id)}</p>
              </header>
            )}
            <div className="collection-previews">
              {group.collections.map((collection) => (
                <CollectionLink
                  key={collection.id}
                  search={{ category: collection.id }}
                  className="collection-preview"
                >
                  <div className="collection-preview-image">
                    {collection.imageUrl ? (
                      <img
                        src={collection.imageUrl}
                        srcSet={collection.image?.srcSet}
                        sizes="(max-width: 700px) 100vw, 50vw"
                        width={collection.image?.width}
                        height={collection.image?.height}
                        alt={
                          collection.imageAlt || categoryLabel(collection.id)
                        }
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span>{categoryLabel(collection.id)}</span>
                    )}
                  </div>
                  <div className="collection-preview-copy">
                    <span className="collection-kind">
                      {m.collection_label()}
                    </span>
                    <CollectionHeading>
                      {categoryLabel(collection.id)}
                      <ArrowUpRight size={22} aria-hidden="true" />
                    </CollectionHeading>
                    <p>{localizedCategoryDescription(collection)}</p>
                  </div>
                </CollectionLink>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
