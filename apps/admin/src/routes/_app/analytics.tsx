import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/analytics")({
  component: () => (
    <PlaceholderPage
      title="Analytics"
      description="Sales and storefront performance."
    />
  ),
});
