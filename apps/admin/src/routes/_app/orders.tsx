import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/orders")({
  component: () => (
    <PlaceholderPage
      title="Orders"
      description="Review, fulfil and refund customer orders."
    />
  ),
});
