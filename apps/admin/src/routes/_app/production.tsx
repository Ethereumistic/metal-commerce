import { createFileRoute } from "@tanstack/react-router";
import { ProductionHistory } from "@/features/production/history";

export const Route = createFileRoute("/_app/production")({
  ssr: false,
  head: () => ({ meta: [{ title: "Production · Metal Craft Admin" }] }),
  component: ProductionHistory,
});
