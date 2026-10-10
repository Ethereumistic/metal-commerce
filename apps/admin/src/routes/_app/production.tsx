import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/production")({
  component: () => (
    <PlaceholderPage
      title="Production"
      description="Laser and fabrication jobs for open orders."
    />
  ),
});
