import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { Photo } from "@/components/photo";
import { OakStory } from "@/components/oak-story";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: m.about() + " — MORIS" },
      { name: "description", content: m.about_intro() },
    ],
  }),
  component: AboutPage,
});
function AboutPage() {
  return (
    <SiteShell>
      <div className="page-container">
        <nav className="breadcrumb" aria-label={m.home()}>
          <Link to="/">{m.home()}</Link>
          <span>/</span>
          <span>{m.about()}</span>
        </nav>
      </div>
      <OakStory variant="about" />
      <div className="page-container">
        <section className="about-statement">
          <h2>{m.perspective_heading()}</h2>
          <div>
            <p>{m.about_intro()}</p>
            <p>{m.about_second()}</p>
            <Link to="/collection" search={{}} className="text-link">
              {m.view_collection()}
              <ArrowUpRight size={18} />
            </Link>
          </div>
        </section>
        <section id="materials" className="materials-section">
          <Photo
            name="oak-patina"
            alt={m.oak_patina_caption()}
            sizes="(max-width: 900px) 100vw, 50vw"
          />
          <div>
            <p className="small-label">{m.materials()}</p>
            <h2>{m.material_title()}</h2>
            <p>{m.material_body()}</p>
            <p>{m.care_body()}</p>
            <Link
              to="/collection"
              search={{ material: "wood" }}
              className="text-link"
            >
              {m.view_collection()}
              <ArrowUpRight size={18} />
            </Link>
          </div>
        </section>
      </div>
    </SiteShell>
  );
}
