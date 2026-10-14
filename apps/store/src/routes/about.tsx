import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/about")({
  head: () => ({ meta: [
    { title: m.about() + " — Metal Craft" },
    { name: "description", content: m.about_intro() },
  ] }),
  component: AboutPage,
});
function AboutPage() {
  return (
    <SiteShell>
      <div className="page-container">
        <nav className="breadcrumb" aria-label={m.home()}>
          <Link to="/">{m.home()}</Link><span>/</span><span>{m.about()}</span>
        </nav>
        <section className="about-statement">
          <h1>{m.about_title()}</h1>
          <div>
            <p>{m.about_intro()}</p>
            <p>{m.about_second()}</p>
            <Link to="/collection" search={{}} className="text-link">
              {m.view_collection()}
              <ArrowUpRight size={18} />
            </Link>
          </div>
        </section>
        <section id="materials" className="about-statement">
          <h2>{m.materials()}</h2>
          <p>{m.material_body()}</p>
        </section>
      </div>
    </SiteShell>
  );
}
