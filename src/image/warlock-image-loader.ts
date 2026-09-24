import type { ImageLoader } from "./types";

/**
 * The default `<Image>` loader — builds a URL the dev/production asset
 * pipeline resolves at request time. Never runs Sharp or touches the
 * filesystem itself; it only formats a query string.
 *
 * A `src` that already carries a query (`/a.jpg?v=3`, signed URLs) gets the
 * variant params appended with `&`; a fragment stays at the end.
 */
export const warlockImageLoader: ImageLoader = ({ src, variant, format }) => {
  const hashIndex = src.indexOf("#");
  const base = hashIndex === -1 ? src : src.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : src.slice(hashIndex);
  const separator = base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?";

  return `${base}${separator}variant=${encodeURIComponent(variant)}${format ? `&format=${format}` : ""}${hash}`;
};
