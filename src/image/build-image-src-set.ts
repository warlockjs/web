import type { ImageFormat, ImageLoader } from "./types";
import type { NamedImageVariant } from "./sort-image-variants";
import { resolveDefaultVariantUrl, resolveFormatVariantUrl } from "./resolve-variant-url";

/** `srcSet` for the default format: `"<url> <width>w"` per variant, joined by `", "`. */
export function buildDefaultSrcSet(
  src: string,
  variants: readonly NamedImageVariant[],
  loader: ImageLoader,
): string {
  return variants
    .map(
      ({ name, descriptor }) =>
        `${resolveDefaultVariantUrl(src, name, descriptor, loader)} ${descriptor.width}w`,
    )
    .join(", ");
}

/** `srcSet` for one extra `<source>` format, same shape as {@link buildDefaultSrcSet}. */
export function buildFormatSrcSet(
  src: string,
  variants: readonly NamedImageVariant[],
  format: ImageFormat,
  loader: ImageLoader,
): string {
  return variants
    .map(
      ({ name, descriptor }) =>
        `${resolveFormatVariantUrl(src, name, descriptor, format, loader)} ${descriptor.width}w`,
    )
    .join(", ");
}
