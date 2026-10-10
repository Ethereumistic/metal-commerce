import type { ComponentProps } from "react";

export function Photo({
  name,
  alt,
  priority = false,
  sizes = "100vw",
  className,
  ...props
}: Omit<ComponentProps<"img">, "src"> & { name: string; priority?: boolean }) {
  return (
    <img
      src={"/images/" + name + "-1280.webp"}
      srcSet={
        "/images/" +
        name +
        "-640.webp 640w, /images/" +
        name +
        "-1280.webp 1280w, /images/" +
        name +
        "-1920.webp 1920w"
      }
      sizes={sizes}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      className={className}
      {...props}
    />
  );
}
