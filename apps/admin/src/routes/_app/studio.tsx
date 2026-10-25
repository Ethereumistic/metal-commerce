import { createFileRoute } from "@tanstack/react-router";
import { validateStudioSearch } from "@/features/production/search";
import { Studio } from "@/features/studio/components/studio";

// Browser-only: designs live in localStorage and geometry is measured in the DOM.
export const Route = createFileRoute("/_app/studio")({
  ssr: false,
  staticData: { fullBleed: true },
  validateSearch: validateStudioSearch,
  head: () => ({ meta: [{ title: "Studio · Metal Craft Admin" }] }),
  component: Studio,
});
