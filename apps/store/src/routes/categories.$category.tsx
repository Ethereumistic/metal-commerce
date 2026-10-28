import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { SiteShell } from "@/components/site-shell";
import { CategoryDirectory } from "@/components/category-directory";
import {
  categoryGroups,
  collectionGroup,
  type CategoryGroup,
} from "@/lib/taxonomy";
import { groupDescription, groupLabel } from "@/lib/taxonomy-copy";
import { useCategories } from "@/lib/commerce";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/categories/$category")({
  loader: async ({ params, parentMatchPromise }) => {
    const parent = await parentMatchPromise;
    if (
      !categoryGroups.includes(params.category as CategoryGroup) ||
      (parent.loaderData?.status === "ready" &&
        !parent.loaderData.categories.some(
          (c) => collectionGroup(c.id) === params.category,
        ))
    )
      throw notFound();
    return { category: params.category as CategoryGroup };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData ? groupLabel(loaderData.category) : m.categories()} — Metal Craft`,
      },
      {
        name: "description",
        content: loaderData
          ? groupDescription(loaderData.category)
          : m.collection_intro(),
      },
    ],
  }),
  component: () => {
    const { category } = Route.useLoaderData();
    const { categories, status } = useCategories();
    return (
      <SiteShell>
        <div className="page-container category-page">
          <nav className="breadcrumb" aria-label={m.home()}>
            <Link to="/">{m.home()}</Link>
            <span>/</span>
            <Link to="/collection" search={{}}>
              {m.collection()}
            </Link>
            <span>/</span>
            <span aria-current="page">{groupLabel(category)}</span>
          </nav>
          <section className="collection-intro">
            <h1>{groupLabel(category)}</h1>
            <p>{groupDescription(category)}</p>
          </section>
          {status !== "ready" ? (
            <p role="status">{m.categories_unavailable()}</p>
          ) : (
            <CategoryDirectory
              collections={categories.filter(
                (c) => collectionGroup(c.id) === category,
              )}
              showHeading={false}
              showGroups={false}
            />
          )}
        </div>
      </SiteShell>
    );
  },
});
