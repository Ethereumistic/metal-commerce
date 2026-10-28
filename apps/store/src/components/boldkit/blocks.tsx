import { CollectionLink } from "@/components/collection-link";
/*
 * Marketing blocks adapted from BoldKit (MIT): StatsCards, FeatureGridWithIcons,
 * FAQAccordion and BentoGrid. Markup and tokens follow the originals; data and
 * links are the store's own, and the accordion uses the shared Base UI one.
 */
import type { ReactNode } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@workspace/ui/components/accordion";
import { cn } from "@/lib/utils";

const tints = ["bg-primary", "bg-secondary", "bg-accent", "bg-card"] as const;

export function SectionHeading({
  id,
  title,
  description,
  action,
  className,
}: {
  id?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-10 flex flex-col items-start justify-between gap-5 md:flex-row md:items-end",
        className,
      )}
    >
      <div className="space-y-3">
        <h2 id={id} className="bk-heading">
          {title}
        </h2>
        {description && (
          <p className="max-w-[48ch] text-lg font-medium text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

/* BoldKit StatsCards */
export function StatsCards({
  title,
  stats,
}: {
  title: string;
  stats: { value: string; label: string }[];
}) {
  return (
    <section
      className="border-y-3 border-foreground bg-muted px-4 py-16 md:px-8 lg:px-16"
      aria-labelledby="stats-heading"
    >
      <div className="mx-auto max-w-7xl">
        <SectionHeading id="stats-heading" title={title} />
        <div className="grid grid-cols-2 gap-4 md:gap-6 lg:grid-cols-4">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className={cn(
                "border-3 border-foreground p-5 shadow-[4px_4px_0px_hsl(var(--shadow-color))] transition hover:translate-x-[-4px] hover:translate-y-[-4px] hover:shadow-[8px_8px_0px_hsl(var(--shadow-color))] md:p-6",
                tints[index % tints.length],
              )}
            >
              <div className="bk-stat">{stat.value}</div>
              <div className="mt-3 text-sm font-bold uppercase tracking-wide">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* BoldKit FeatureGridWithIcons, used for the production sequence */
export function FeatureSteps({
  id,
  title,
  stepLabel,
  steps,
}: {
  id?: string;
  title: string;
  stepLabel: (number: number) => string;
  steps: { title: string; description: string; icon: ReactNode }[];
}) {
  return (
    <section
      id={id}
      className="px-4 py-20 md:px-8 lg:px-16"
      aria-labelledby="steps-heading"
    >
      <div className="mx-auto max-w-7xl">
        <SectionHeading id="steps-heading" title={title} />
        <ol className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, index) => (
            <li
              key={step.title}
              className="relative border-3 border-foreground bg-card shadow-[4px_4px_0px_hsl(var(--shadow-color))] transition hover:translate-x-[-4px] hover:translate-y-[-4px] hover:shadow-[8px_8px_0px_hsl(var(--shadow-color))]"
            >
              <div className="flex items-center justify-between border-b-3 border-foreground p-5">
                <div
                  className={cn(
                    "flex size-14 items-center justify-center border-3 border-foreground shadow-[3px_3px_0px_hsl(var(--shadow-color))] [&_svg]:size-6",
                    tints[index % 3],
                  )}
                >
                  {step.icon}
                </div>
                <span className="font-mono text-sm font-medium">
                  {stepLabel(index + 1)}
                </span>
              </div>
              <div className="p-5">
                <h3 className="text-xl font-black uppercase tracking-wide">
                  {step.title}
                </h3>
                <p className="mt-2 text-base text-muted-foreground">
                  {step.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* BoldKit FAQAccordion */
export function FAQAccordion({
  title,
  items,
}: {
  title: string;
  items: { question: string; answer: string }[];
}) {
  return (
    <section
      className="px-4 py-20 md:px-8 lg:px-16"
      aria-labelledby="faq-heading"
    >
      <div className="mx-auto grid max-w-7xl items-start gap-10 lg:grid-cols-[1fr_1.6fr]">
        <SectionHeading id="faq-heading" title={title} className="mb-0" />
        <Accordion className="space-y-4">
          {items.map((item) => (
            <AccordionItem
              key={item.question}
              value={item.question}
              className="border-3 border-foreground bg-card shadow-[4px_4px_0px_hsl(var(--shadow-color))] transition data-[open]:translate-x-[-2px] data-[open]:translate-y-[-2px] data-[open]:bg-primary/25 data-[open]:shadow-[6px_6px_0px_hsl(var(--shadow-color))]"
            >
              <AccordionTrigger className="rounded-none px-5 py-4 text-base font-bold uppercase tracking-wide hover:no-underline **:data-[slot=accordion-trigger-icon]:size-5 **:data-[slot=accordion-trigger-icon]:text-foreground">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="px-5 pb-5 text-base text-foreground/80">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

/* BoldKit BentoGrid, filled with collections */
export function CollectionBento({
  title,
  description,
  action,
  collections,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  collections: {
    id: string;
    label: string;
    image?: {
      src: string;
      srcSet?: string;
      width?: number;
      height?: number;
      alt: string;
    };
  }[];
}) {
  // A large first tile makes the grid read as a bento rather than a table.
  const span = (index: number) => (index === 0 ? "col-span-2 row-span-2" : "");
  return (
    <section
      id="collections"
      className="px-4 py-20 md:px-8 lg:px-16"
      aria-labelledby="collections-heading"
    >
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          id="collections-heading"
          title={title}
          description={description}
          action={action}
        />
        <div className="grid grid-flow-dense grid-cols-2 gap-4 md:grid-cols-4 md:gap-5 lg:grid-cols-6">
          {collections.map((item, index) => (
            <CollectionLink
              key={item.id}
              search={{ category: item.id }}
              className={cn(
                "group flex flex-col border-3 border-foreground bg-card shadow-[4px_4px_0px_hsl(var(--shadow-color))] transition hover:translate-x-[-3px] hover:translate-y-[-3px] hover:shadow-[7px_7px_0px_hsl(var(--shadow-color))] focus-visible:translate-x-[-3px] focus-visible:translate-y-[-3px]",
                span(index),
              )}
            >
              <div
                className={cn(
                  "relative flex-1 overflow-hidden bg-white",
                  "aspect-square",
                )}
              >
                {item.image ? (
                  <img
                    src={item.image.src}
                    srcSet={item.image.srcSet}
                    sizes={
                      index === 0
                        ? "(max-width: 1000px) 100vw, 33vw"
                        : "(max-width: 600px) 50vw, (max-width: 1000px) 25vw, 16vw"
                    }
                    width={item.image.width}
                    height={item.image.height}
                    alt={item.image.alt}
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover transition duration-300 group-hover:scale-[1.04]"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="bk-placeholder flex size-full items-center justify-center p-3 text-center"
                  >
                    {item.label}
                  </span>
                )}
              </div>
              <span
                className={cn(
                  "flex items-center justify-between gap-2 border-t-3 border-foreground px-3 py-2 font-bold uppercase leading-tight tracking-wide group-hover:bg-primary",
                  index === 0 ? "bg-primary text-lg" : "text-sm",
                )}
              >
                {item.label}
              </span>
            </CollectionLink>
          ))}
        </div>
      </div>
    </section>
  );
}
