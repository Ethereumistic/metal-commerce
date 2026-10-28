import type { StoreCategory } from "./commerce";

// Storefront navigation groups. Commerce continues to own collection names and membership.
// Only collections returned by the public catalog are rendered.
export const categoryGroups = [
  "wall-art",
  "collectibles",
  "more-collections",
] as const;
export type CategoryGroup = (typeof categoryGroups)[number];

export function collectionSlug(name: string) {
  return name.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, "-");
}

export function collectionGroup(name: string): CategoryGroup {
  switch (collectionSlug(name)) {
    case "architecture":
      return "wall-art";
    case "ninja-blades":
      return "collectibles";
    default:
      return "more-collections";
  }
}

export function groupedCollections(collections: StoreCategory[]) {
  return categoryGroups
    .map((id) => ({
      id,
      collections: collections.filter((c) => collectionGroup(c.id) === id),
    }))
    .filter((group) => group.collections.length > 0);
}
