import { m } from "@/paraglide/messages";
import english from "../../messages/en.json";
import { categoryIds, categoryDescription, type CategoryId } from "./catalog";
import type { StoreCategory } from "./commerce";

export function localizedCategoryDescription(category: StoreCategory) {
  if (
    category.id === "Architecture" &&
    category.description === english.architecture_description
  )
    return m.architecture_description();
  if (
    category.id === "Ninja Blades" &&
    category.description === english.ninja_blades_description
  )
    return m.ninja_blades_description();
  const id = category.id as CategoryId;
  if (
    categoryIds.includes(id) &&
    category.description === english[`desc_${id}`]
  ) {
    return categoryDescription(id);
  }
  return category.description;
}
