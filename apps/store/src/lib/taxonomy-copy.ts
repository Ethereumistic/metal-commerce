import { m } from "@/paraglide/messages";
import type { CategoryGroup } from "./taxonomy";

export function groupLabel(id: CategoryGroup) {
  return {
    "wall-art": m.wall_art,
    collectibles: m.collectibles,
    "more-collections": m.more_collections,
  }[id]();
}

export function groupDescription(id: CategoryGroup) {
  return {
    "wall-art": m.wall_art_description,
    collectibles: m.collectibles_description,
    "more-collections": m.more_collections_description,
  }[id]();
}
