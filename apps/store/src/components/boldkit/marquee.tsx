import { Fragment, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const speedClasses = {
  slow: "animate-marquee-slow",
  normal: "animate-marquee",
  fast: "animate-marquee-fast",
};

export function Marquee({
  className,
  children,
  direction = "left",
  speed = "normal",
  repeat = 4,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  direction?: "left" | "right";
  speed?: keyof typeof speedClasses;
  repeat?: number;
}) {
  const track = (hidden: boolean) => (
    <div
      className={cn(
        "marquee-content flex shrink-0 items-center gap-6 py-2.5 hover:[animation-play-state:paused]",
        speedClasses[speed],
      )}
      style={{ animationDirection: direction === "right" ? "reverse" : undefined }}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      {Array.from({ length: repeat }).map((_, i) => (
        <Fragment key={i}>{children}</Fragment>
      ))}
    </div>
  );
  return (
    <div className={cn("flex overflow-hidden", className)} {...props}>
      {track(false)}
      {track(true)}
    </div>
  );
}

export function MarqueeItem({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap px-2 font-bold uppercase tracking-wide",
        className,
      )}
      {...props}
    />
  );
}
