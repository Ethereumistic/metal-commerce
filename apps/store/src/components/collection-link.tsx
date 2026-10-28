import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { collectionSlug } from "@/lib/taxonomy";
import type { CollectionSearch } from "@/lib/collection-search";

export function CollectionLink({
  search = {},
  children,
  ...props
}: {
  search?: CollectionSearch;
  children: ReactNode;
} & Pick<
  ComponentProps<"a">,
  "className" | "onClick" | "aria-current" | "aria-label" | "id"
> & { "data-current"?: string }) {
  const { category, ...filters } = search;
  return category ? (
    <Link
      to="/collections/$collection"
      params={{ collection: collectionSlug(category) }}
      search={filters}
      {...props}
    >
      {children}
    </Link>
  ) : (
    <Link to="/collection" search={filters} {...props}>
      {children}
    </Link>
  );
}
