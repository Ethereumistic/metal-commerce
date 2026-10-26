import { useLayoutEffect, useState } from "react";
import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
  useMatches,
} from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb";
import { Separator } from "@workspace/ui/components/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { getSession } from "@/lib/auth";
import { titleFor } from "@/lib/navigation";

// Every admin page sits behind this gate; the server re-checks business membership on each load.
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const session = await getSession();
    if (!session)
      throw redirect({
        to: "/login",
        search: location.pathname === "/" ? {} : { next: location.pathname },
      });
    return { session };
  },
  component: AppLayout,
});

/** Below this width the sidebar starts as an icon rail so dense pages keep their room. */
const WIDE_QUERY = "(min-width: 1280px)";

/**
 * Sidebar open on wide screens, collapsed to icons on narrower ones. The
 * operator's own toggle wins until the window crosses the breakpoint again.
 */
function useResponsiveSidebar() {
  const [open, setOpen] = useState(true);
  useLayoutEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const sync = () => setOpen(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return [open, setOpen] as const;
}

function AppLayout() {
  const { session } = Route.useRouteContext();
  const { pathname } = useLocation();
  const fullBleed = useMatches({
    select: (matches) => matches.some((match) => match.staticData.fullBleed),
  });
  const [sidebarOpen, setSidebarOpen] = useResponsiveSidebar();
  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <AppSidebar session={session} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                {session.business.name}
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>{titleFor(pathname)}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <ThemeToggle className="ml-auto" />
        </header>
        {fullBleed ? (
          <div className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col">
            <Outlet />
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
            <Outlet />
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
