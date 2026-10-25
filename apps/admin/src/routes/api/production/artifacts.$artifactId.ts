import { createFileRoute } from "@tanstack/react-router";
import { RESOURCE_ID } from "@/features/production/contracts";

// Download-only proxy for production artifacts (DXF, SVG, PNG, ZIP). GET only:
// every mutation goes through server functions, which carry TanStack's CSRF
// protection. The session and membership are checked on each download.
export const Route = createFileRoute("/api/production/artifacts/$artifactId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!RESOURCE_ID.test(params.artifactId))
          return new Response("Not found", { status: 404 });
        const { artifactResponse } = await import("@/lib/production.server");
        return artifactResponse(params.artifactId);
      },
    },
  },
});
