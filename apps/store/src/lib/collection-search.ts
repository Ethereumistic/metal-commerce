import type { Material } from "./catalog";
export type CollectionSearch = {
  category?: string;
  material?: Material;
  sort?: "name";
  q?: string;
  cursor?: string;
};
const materials: Material[] = ["wood", "fabric", "metal", "glass"];
export const collectionSearch = (
  search: Record<string, unknown>,
): CollectionSearch => ({
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
});
