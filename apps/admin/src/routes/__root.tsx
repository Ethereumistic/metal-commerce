import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import stylesheet from "@/styles.css?url";
import { themeScript } from "@/lib/theme";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "robots", content: "noindex, nofollow" },
      { title: "Metal Craft Admin" },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
  }),
  component: RootDocument,
  notFoundComponent: () => (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        This admin page does not exist.
      </p>
      <Button render={<Link to="/" />} variant="outline">
        Back to overview
      </Button>
    </main>
  ),
});

function RootDocument() {
  return (
    // The theme script sets the `dark` class before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
