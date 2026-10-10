import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/settings")({
  component: () => (
    <PlaceholderPage
      title="Settings"
      description="Store, team and integration settings."
    />
  ),
});
