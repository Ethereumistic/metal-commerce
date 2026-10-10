import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/products")({
  component: () => (
    <PlaceholderPage
      title="Products"
      description="Manage the Metal Craft catalogue, variants and pricing."
    />
  ),
});
