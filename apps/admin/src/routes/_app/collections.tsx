import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/collections")({
  component: () => (
    <PlaceholderPage
      title="Collections"
      description="Group products into storefront collections."
    />
  ),
});
