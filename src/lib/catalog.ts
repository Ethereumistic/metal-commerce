import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

export const categoryIds = [
  "tables",
  "chairs",
  "desks",
  "lamps",
  "sideboards",
  "mirrors",
  "benches",
] as const;
export type CategoryId = (typeof categoryIds)[number];
export type Material = "wood" | "fabric" | "metal" | "glass";
export function categoryLabel(id: string) {
  if (!categoryIds.includes(id as CategoryId)) return id;
  return {
    tables: m.tables,
    chairs: m.chairs,
    desks: m.desks,
    lamps: m.lamps,
    sideboards: m.sideboards,
    mirrors: m.mirrors,
    benches: m.benches,
  }[id as CategoryId]();
}
export function categoryDescription(id: CategoryId) {
  return {
    tables: m.desc_tables,
    chairs: m.desc_chairs,
    desks: m.desc_desks,
    lamps: m.desc_lamps,
    sideboards: m.desc_sideboards,
    mirrors: m.desc_mirrors,
    benches: m.desc_benches,
  }[id]();
}
export function materialLabel(material: Material) {
  return { wood: m.wood, fabric: m.fabric, metal: m.metal, glass: m.glass }[
    material
  ]();
}
export function pieceCount(count: number) {
  const input = { count: new Intl.NumberFormat(getLocale()).format(count) };
  return new Intl.PluralRules(getLocale()).select(count) === "one"
    ? m.piece_count_one(input)
    : m.piece_count(input);
}
