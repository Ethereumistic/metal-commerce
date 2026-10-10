import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/")({
  component: Overview,
});

const stats = ["Revenue", "Orders", "Products", "Customers"];

function Overview() {
  const { session } = Route.useRouteContext();
  const name = session.user.name?.split(" ")[0];
  return (
    <PlaceholderPage
      title={name ? `Welcome back, ${name}` : "Welcome back"}
      description={`Overview of ${session.business.name}.`}
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat} size="sm">
            <CardHeader>
              <CardDescription>{stat}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">—</CardTitle>
              <Badge variant="outline" className="w-fit">
                Placeholder
              </Badge>
            </CardHeader>
          </Card>
        ))}
      </div>
    </PlaceholderPage>
  );
}
