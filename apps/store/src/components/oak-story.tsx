import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Tabs } from "@base-ui/react/tabs";
import { ArrowUpRight, Plus } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@workspace/ui/components/dialog";
import { Photo } from "./photo";
import { m } from "@/paraglide/messages";

type Chapter = "grain" | "patina" | "life";

export function OakStory({ variant = "home" }: { variant?: "home" | "about" }) {
  const [chapter, setChapter] = useState<Chapter>("grain");
  const Heading = variant === "about" ? "h1" : "h2";
  const chapters = [
    {
      id: "grain" as const,
      label: m.oak_grain_label,
      title: m.oak_grain_title,
      body: m.oak_grain_body,
      detail: m.oak_grain_detail,
      caption: m.oak_grain_caption,
      image: "oak-rings",
    },
    {
      id: "patina" as const,
      label: m.oak_patina_label,
      title: m.oak_patina_title,
      body: m.oak_patina_body,
      detail: m.oak_patina_detail,
      caption: m.oak_patina_caption,
      image: "oak-patina",
    },
    {
      id: "life" as const,
      label: m.oak_life_label,
      title: m.oak_life_title,
      body: m.oak_life_body,
      detail: m.oak_life_detail,
      caption: m.oak_life_caption,
      image: "oak-chair",
    },
  ];
  const selected = chapters.find((item) => item.id === chapter)!;

  return (
    <section
      id="oak-story"
      className={"oak-story oak-story-" + variant}
      aria-labelledby="oak-story-heading"
    >
      <div className="oak-story-inner">
        <header className="oak-story-header">
          <Heading id="oak-story-heading">{m.oak_heading()}</Heading>
          <div className="oak-story-intro">
            <p className="oak-origin">
              <img
                src="https://flagcdn.com/bg.svg"
                width="21"
                height="14"
                alt=""
              />
              {m.oak_origin()}
            </p>
            <p>{m.oak_intro()}</p>
          </div>
        </header>
        <Tabs.Root
          value={chapter}
          onValueChange={(value) => {
            if (value === "grain" || value === "patina" || value === "life") {
              setChapter(value);
            }
          }}
          className="oak-story-explorer"
          data-chapter={chapter}
        >
          <div className="oak-story-stage">
            <figure className="oak-story-visual">
              <div className="oak-story-images" aria-hidden="true">
                {chapters.map((item, index) => (
                  <Photo
                    key={item.id}
                    name={item.image}
                    alt=""
                    priority={variant === "about" && index === 0}
                    sizes="(max-width: 900px) 100vw, 65vw"
                    className={"oak-story-image oak-image-" + item.id}
                    data-active={chapter === item.id}
                  />
                ))}
              </div>
              <svg
                className="oak-ring-trace"
                viewBox="0 0 1000 667"
                preserveAspectRatio="xMidYMid slice"
                aria-hidden="true"
              >
                <ellipse cx="459" cy="319" rx="156" ry="145" />
                <ellipse cx="459" cy="319" rx="168" ry="156" />
              </svg>
              {chapter === "grain" && (
                <>
                  <svg
                    className="oak-ring-trace oak-ring-leader"
                    viewBox="0 0 1000 667"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path d="M 589 229 L 700 119 L 950 119" />
                    <circle cx="589" cy="229" r="4" />
                  </svg>
                  <Link
                    to="/collection"
                    search={{}}
                    className="oak-grain-link"
                  >
                    <span>{m.view_collection()}</span>
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </Link>
                </>
              )}
              <div className="oak-visual-footer">
                <figcaption>{selected.caption()}</figcaption>
                <Dialog>
                  <DialogTrigger
                    aria-label={m.oak_look_closer()}
                    render={
                      <Button variant="ghost" className="oak-look-closer" />
                    }
                  >
                    <span>{m.oak_look_closer()}</span>
                    <Plus size={21} />
                  </DialogTrigger>
                  <DialogContent closeLabel={m.close()} className="image-dialog oak-image-dialog">
                    <DialogTitle className="sr-only">
                      {selected.caption()}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                      {selected.body()}
                    </DialogDescription>
                    <Photo
                      name={selected.image}
                      alt={selected.caption()}
                      priority
                    />
                    <p className="oak-dialog-caption">{selected.caption()}</p>
                  </DialogContent>
                </Dialog>
              </div>
            </figure>
            <Tabs.List
              className="oak-story-tabs"
              aria-label={m.oak_chapters()}
              activateOnFocus
            >
              {chapters.map((item, index) => (
                <Tabs.Tab
                  key={item.id}
                  value={item.id}
                  className="oak-story-tab"
                >
                  <span aria-hidden="true">{"0" + (index + 1)}</span>
                  {item.label()}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <div className="oak-story-reading">
              <p className="oak-reading-label">{m.oak_reading_label()}</p>
              {chapters.map((item) => (
                <Tabs.Panel
                  key={item.id}
                  value={item.id}
                  className="oak-story-panel"
                >
                  <h3>{item.title()}</h3>
                  <p>{item.body()}</p>
                  <p className="oak-chapter-detail">{item.detail()}</p>
                </Tabs.Panel>
              ))}
            </div>
          </div>
          <div className="oak-story-bottom">
            {variant === "home" ? (
              <Link to="/about" className="oak-story-link">
                {m.oak_story_link()}
                <ArrowUpRight size={20} />
              </Link>
            ) : (
              <Link to="/collection" search={{}} className="oak-story-link">
                {m.view_collection()}
                <ArrowUpRight size={20} />
              </Link>
            )}
          </div>
        </Tabs.Root>
      </div>
    </section>
  );
}
