const aliases = [
  "Tables",
  "Chairs",
  "Desks",
  "Lamps",
  "Sideboards",
  "Mirrors",
  "Benches",
];
export function categoryKey(name: string) {
  return aliases.some((alias) => alias.toLowerCase() === name.toLowerCase())
    ? name.toLowerCase()
    : name;
}
export function backendCollection(key: string) {
  return aliases.find((alias) => alias.toLowerCase() === key) ?? key;
}
