import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const stickerVariants = cva(
  "relative inline-flex items-center justify-center border-3 border-foreground font-bold uppercase tracking-wide shadow-[4px_4px_0px_hsl(var(--shadow-color))]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        accent: "bg-accent text-accent-foreground",
        outline: "bg-card text-foreground",
      },
      size: {
        sm: "px-2 py-1 text-xs",
        default: "px-3 py-1.5 text-sm",
        lg: "px-4 py-2 text-base",
      },
      rotation: {
        none: "rotate-0",
        slight: "-rotate-2",
        medium: "-rotate-6",
        "slight-right": "rotate-2",
        "medium-right": "rotate-6",
      },
    },
    defaultVariants: { variant: "default", size: "default", rotation: "slight" },
  },
);

/** Rotated label with a strip of tape, as BoldKit's Sticker. */
export function Sticker({
  className,
  variant,
  size,
  rotation,
  tape = false,
  ...props
}: HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof stickerVariants> & { tape?: boolean }) {
  return (
    <div
      className={cn(
        stickerVariants({ variant, size, rotation }),
        tape &&
          "after:absolute after:left-1/2 after:top-[-10px] after:h-[16px] after:w-[50px] after:-translate-x-1/2 after:rotate-[-3deg] after:border-2 after:border-foreground after:bg-card/80",
        className,
      )}
      {...props}
    />
  );
}

/** Round rubber stamp, as BoldKit's Stamp. */
export function Stamp({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative inline-flex h-28 w-28 -rotate-12 items-center justify-center rounded-full border-4 border-foreground bg-accent text-accent-foreground font-black uppercase tracking-widest shadow-[4px_4px_0px_hsl(var(--shadow-color))] ring-2 ring-foreground ring-offset-2 ring-offset-background",
        className,
      )}
      {...props}
    >
      <span className="text-center text-xs leading-tight">{children}</span>
    </div>
  );
}
