import english from "../../messages/en.json";
import { categoryIds, categoryDescription, type CategoryId } from "./catalog";
import type { StoreCategory } from "./commerce";

export function localizedCategoryDescription(category: StoreCategory) {
  const id = category.id as CategoryId;
  if (categoryIds.includes(id) && category.description === english[`desc_${id}`]) {
    return categoryDescription(id);
  }
  return category.description;
}
