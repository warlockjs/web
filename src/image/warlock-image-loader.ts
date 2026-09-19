import type { ImageLoader } from "./types";

/**
 * The default `<Image>` loader — builds a URL the dev/production asset
 * pipeline resolves at request time. Never runs Sharp or touches the
 * filesystem itself; it only formats a query string.
 */
export const warlockImageLoader: ImageLoader = ({ src, variant, format }) =>
  `${src}?variant=${encodeURIComponent(variant)}${format ? `&format=${format}` : ""}`;
