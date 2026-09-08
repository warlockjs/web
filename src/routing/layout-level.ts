/**
 * The layout-level composition rule shared by both page installers
 * (`../server/install-page-routes.ts`'s dev loop, `../server/install-page-routes-from-manifest.ts`'s
 * production loop): given a page's layout chain, outermost first, which layout
 * hosts the render slot and what URL prefix does the whole chain compose to.
 *
 * Source-agnostic: this module never asks where a layout's module came from
 * (`vite.ssrLoadModule` in dev, an already-loaded manifest entry in
 * production) — it only consumes what each caller already read off that
 * module (`renders`, `prefix`), classified against its own chain identifiers.
 *
 * DIRECTORY CONTRACT — applies to everything in `web/src/routing/`: nothing
 * here may import `node:fs`, `node:path`, `vite`, or `fastify`.
 */
import { composeRoutePath } from "./compose-route-path";
import { NestedLayoutsNotSupportedError, selectPageLayout } from "./layout-policy";

/** One layout on a page's chain, already classified by the caller against its own loaded module. */
export type LayoutLevelEntry = {
  /** Opaque identifier for the layout — an app-root-relative POSIX path, in practice. */
  id: string;
  /** Whether this layout's module has a default export — see `layout-policy.ts`. */
  renders: boolean;
  /** This layout's declared `prefix` export, when it has one. */
  prefix: string | undefined;
};

export type LayoutLevel = {
  /**
   * The layout the handler's layout slot is registered under, or `undefined`
   * when the chain is empty: the layout that RENDERS, or — when none does —
   * the nearest one, which is the slot both installers have always used and
   * so the choice that changes nothing but the middleware for a chain with no
   * wrapper in it.
   */
  hostId: string | undefined;
  /** Every layout's `prefix`, composed outermost first. */
  prefix: string;
};

/**
 * Resolves the layout LEVEL for one page's chain — the collapse from "every
 * layout on the path" to "the one module the render pipeline's single layout
 * slot holds" (`execute-page-request.ts`'s `PageRouteEntry["triple"]`).
 *
 * RENDERING is a selection: at most one layout on the chain may render, and
 * {@link selectPageLayout} picks it. MIDDLEWARE and PREFIX are compositions:
 * every layout on the path contributes, outermost first — a guard on an outer
 * layout that the page's own directory knows nothing about is exactly the
 * guard that must still run, and a prefix nobody composed is a URL nobody
 * wrote down. This function resolves the render selection and the prefix
 * composition; each caller composes its own middleware/loader chain, because
 * that composition needs the loaded module objects this module never sees.
 *
 * `pageId` is caller context for {@link NestedLayoutsNotSupportedError} only —
 * an app-root-relative page identifier, in practice.
 */
export function resolveLayoutLevel(
  pageId: string,
  chain: readonly LayoutLevelEntry[],
): LayoutLevel {
  const selection = selectPageLayout(
    chain.map((entry) => ({ layout: entry.id, renders: entry.renders })),
  );

  if (selection.type === "rejected") {
    throw new NestedLayoutsNotSupportedError(pageId, selection.layouts);
  }

  return {
    hostId: selection.type === "selected" ? selection.layout : chain.at(-1)?.id,
    prefix: chain.reduce(
      (composed, entry) => composeRoutePath(composed, entry.prefix ?? "/"),
      "/",
    ),
  };
}
