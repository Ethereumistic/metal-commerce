import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/inventory")({
  component: () => (
    <PlaceholderPage
      title="Inventory"
      description="Stock levels and made-to-order lead times."
    />
  ),
});
