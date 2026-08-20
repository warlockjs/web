import type { AnchorHTMLAttributes, ReactElement } from "react";

/**
 * M1 shape: `to` is a loose `string` and `params`/`query` are loosely typed.
 * The Stream E typed route map replaces this — `to` becomes the union of
 * declared route names with `params` keyed per route. One consumer constrains
 * that design today: shell.tsx:35 passes a RUNTIME string (`item.route` from
 * the nav service), so the typed map needs either a widening overload or
 * typed nav items.
 */
export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  /** A route NAME, never a URL — a dead name is a compile error, not a 404. */
  to: string;
  /** Route parameters, e.g. `{ id }` for `"/:id"` (products.page.tsx:99). */
  params?: Record<string, unknown>;
  /** Query string values (products.page.tsx:110). */
  query?: Record<string, unknown>;
};

export function Link(_props: LinkProps): ReactElement {
  throw new Error("@warlock.js/web is not implemented yet");
}
