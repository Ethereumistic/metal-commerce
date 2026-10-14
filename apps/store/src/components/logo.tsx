import { cn } from "@/lib/utils";

/**
 * Logomark: a riveted steel plate with a stencil-cut M and the laser's
 * spark on its corner. The gaps beside the M's V are cutting bridges, the
 * small tabs a laser leaves so inner parts don't drop out of the sheet.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="-2 -2 68 68"
      className={cn("logo-mark", className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="10" y="14" width="48" height="48" fill="hsl(var(--shadow-color))" />
      <rect
        x="4"
        y="8"
        width="48"
        height="48"
        fill="hsl(var(--primary))"
        stroke="hsl(var(--foreground))"
        strokeWidth="4"
      />
      <path
        fill="hsl(var(--foreground))"
        d="M13 20h7v26h-7zM36 20h7v26h-7zM22.5 20 28 29l5.5-9v9L28 38l-5.5-9z"
      />
      <circle cx="11.5" cy="15.5" r="2.2" fill="hsl(var(--foreground))" />
      <circle cx="44.5" cy="48.5" r="2.2" fill="hsl(var(--foreground))" />
      <path
        d="M52 0l2.8 7.2L62 10l-7.2 2.8L52 20l-2.8-7.2L42 10l7.2-2.8z"
        fill="hsl(var(--accent))"
        stroke="hsl(var(--foreground))"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mark plus the stacked stencil wordmark. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("logo", className)}>
      <LogoMark />
      <span className="logo-word">
        <span>Metal</span>
        <span>Craft</span>
      </span>
    </span>
  );
}
