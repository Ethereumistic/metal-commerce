import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/customers")({
  component: () => (
    <PlaceholderPage
      title="Customers"
      description="Shopper accounts, addresses and order history."
    />
  ),
});
