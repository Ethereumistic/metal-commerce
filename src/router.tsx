import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { deLocalizeUrl, localizeUrl } from "./paraglide/runtime";

export function getRouter() {
  return createRouter({
    routeTree,
    context: { catalogReceipts: new Map<string, number>() },
    scrollRestoration: true,
    defaultPreload: "intent",
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url),
      output: ({ url }) => localizeUrl(url),
    },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
