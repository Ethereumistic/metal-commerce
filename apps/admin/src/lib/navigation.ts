import {
  BarChart3,
  Boxes,
  Cog,
  Factory,
  FolderTree,
  LayoutDashboard,
  PenTool,
  Package,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { title: string; to: string; icon: LucideIcon };
export type NavGroup = { label: string; items: NavItem[] };

// Placeholder information architecture; pages will be built out later.
export const navigation: NavGroup[] = [
  {
    label: "Store",
    items: [
      { title: "Overview", to: "/", icon: LayoutDashboard },
      { title: "Orders", to: "/orders", icon: ShoppingCart },
      { title: "Products", to: "/products", icon: Package },
      { title: "Collections", to: "/collections", icon: FolderTree },
      { title: "Customers", to: "/customers", icon: Users },
    ],
  },
  {
    label: "Design",
    items: [{ title: "Studio", to: "/studio", icon: PenTool }],
  },
  {
    label: "Operations",
    items: [
      { title: "Inventory", to: "/inventory", icon: Boxes },
      { title: "Production", to: "/production", icon: Factory },
      { title: "Analytics", to: "/analytics", icon: BarChart3 },
    ],
  },
  {
    label: "Admin",
    items: [{ title: "Settings", to: "/settings", icon: Cog }],
  },
];

export function titleFor(pathname: string) {
  for (const group of navigation)
    for (const item of group.items) if (item.to === pathname) return item.title;
  return "Admin";
}
