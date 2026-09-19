import type { ImageVariantDescriptor } from "./types";

export type NamedImageVariant = { name: string; descriptor: ImageVariantDescriptor };

/**
 * Variants sorted ascending by width, ties broken by name — deterministic
 * regardless of the source object's key order, so server and client render
 * the same `srcSet` from the same descriptor.
 */
export function sortImageVariants(
  variants: Readonly<Record<string, ImageVariantDescriptor>>,
): NamedImageVariant[] {
  return Object.entries(variants)
    .map(([name, descriptor]) => ({ name, descriptor }))
    .sort((a, b) => {
      if (a.descriptor.width !== b.descriptor.width) {
        return a.descriptor.width - b.descriptor.width;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}
