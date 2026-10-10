import type { StoreProduct } from "./commerce";
import { getLocale } from "@/paraglide/runtime";

export function defaultOption(product: StoreProduct) {
  return product.variants.find(option => option.key === product.defaultVariant) ?? product.variants[0];
}

export function priceLabel(amount: number, currency: string) {
  return new Intl.NumberFormat(getLocale(), { style: "currency", currency, minimumFractionDigits: amount % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(amount / 100);
}

export function specification(product: StoreProduct, label: string) {
  return product.specifications.find(item => item.label.toLowerCase() === label.toLowerCase())?.value;
}
