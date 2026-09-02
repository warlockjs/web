/**
 * The hydration COMPOSER: payload + page registry -> the ReactNode to mount.
 *
 * It takes the registry as an ARGUMENT and touches no browser global, which is
 * the whole point of it living apart from `index.ts`: every rule below is
 * testable with a hand-built registry, no bundler, no virtual module, no DOM.
 *
 * LOOKUP BY NAME, NEVER BY MATCH. `payload.name` is the identity of the entry
 * the SERVER matched for this exact request (document-context.ts's `name`
 * field). Re-deriving it from `location.pathname` with `matchClientRoute`
 * would be a second implementation of route semantics running against the one
 * request it is hydrating, free to disagree with the server that produced the
 * markup. `matchClientRoute` is for client-side NAVIGATION, where no server
 * answer exists yet.
 */
import { createElement, type ComponentType, type ReactNode } from "react";
import type {
  HydrationDocumentPayloadSource,
  SerializedErrorPageProps,
} from "../hydration-payload";
import { registerModules } from "../runtime/register-modules";
import { loadClientRouteComposition } from "./runtime";
import type { ClientPageEntry, ClientProjectedModule } from "./runtime/types";

/** What every composed level receives — the shape `render-page.ts` uses server-side. */
type HydratedLevelProps = {
  readonly data: unknown;
  readonly shared: unknown;
  readonly children?: ReactNode;
};

/** The ordinary page leaf alone receives params from the server's match. */
type HydratedPageProps = {
  readonly data: unknown;
  readonly shared: unknown;
  readonly params: Readonly<Record<string, string>>;
};

function describeKnownNames(knownPageNames: readonly string[]): string {
  if (knownPageNames.length === 0) return "The client page registry is empty.";

  return `The registry knows: ${knownPageNames.map((name) => JSON.stringify(name)).join(", ")}.`;
}

/**
 * The THIRD hydration failure case, beside an absent and a malformed payload.
 *
 * It fails CLOSED — no default entry, no nearest-path fallback, no silent
 * no-op. A registry that quietly substitutes a page produces a browser showing
 * one page's markup running another page's code, which is precisely the defect
 * this entry point was rewritten to remove; a fallback would reintroduce it
 * wearing a recovery costume. Throwing leaves the server-rendered markup on
 * screen and un-hydrated, which is degraded but honest.
 */
export class UnknownHydrationPageNameError extends Error {
  public constructor(
    public readonly pageName: string,
    public readonly knownPageNames: readonly string[],
  ) {
    super(
      `Warlock hydration aborted: the payload names page ${JSON.stringify(pageName)}, which is ` +
        `not in the client page registry. ${describeKnownNames(knownPageNames)} The server ` +
        "rendered a page this browser bundle does not carry, so the server and client were " +
        "built from different page graphs. To fix: rebuild the client bundle, or check that " +
        "the page's file still exports a `route` discovery can see.",
    );
    this.name = "UnknownHydrationPageNameError";
  }
}

/**
 * The server selected an app error page, but this browser graph cannot load it.
 * Substituting the ordinary page would execute the component that already
 * failed and hydrate markup the server did not render, so this path fails
 * closed just like an unknown route name.
 */
export class MissingHydrationErrorPageError extends Error {
  public constructor(public readonly pageName: string) {
    super(
      `Warlock hydration aborted: the server selected error.page.tsx for route ` +
        `${JSON.stringify(pageName)}, but that route's client composition has no ErrorPage ` +
        "module. Rebuild the client page registry so it projects the discovered error page.",
    );
    this.name = "MissingHydrationErrorPageError";
  }
}

function findEntryByName(
  pages: readonly ClientPageEntry[],
  name: string,
): ClientPageEntry {
  const entry = pages.find((candidate) => candidate.name === name);

  if (entry === undefined) {
    throw new UnknownHydrationPageNameError(
      name,
      pages.map((candidate) => candidate.name),
    );
  }

  return entry;
}

/**
 * A level's component, or undefined when the module exports no default.
 *
 * Undefined is NOT an error: `render-page.ts:258` and `:279` treat a missing
 * default as a passthrough server-side, and the client tree has to match the
 * markup React is hydrating against — introducing a level here that the server
 * did not render is a hydration mismatch, not a repair.
 */
function componentOf<Props extends object>(
  module: ClientProjectedModule,
): ComponentType<Props> | undefined {
  const component = module.default;

  return typeof component === "function"
    ? (component as ComponentType<Props>)
    : undefined;
}

function wrap(
  module: ClientProjectedModule,
  data: unknown,
  shared: unknown,
  children: ReactNode,
): ReactNode {
  const Component = componentOf<HydratedLevelProps>(module);

  if (Component === undefined) return children;

  return createElement(Component, { data, shared, children });
}

/**
 * Compose the tree the server rendered inside `#root`: ordered layouts wrapping
 * the selected Page or ErrorPage leaf, layouts OUTERMOST FIRST as
 * `ClientRouteComposition` declares them. Ordinary levels receive
 * `{ data, shared }`; the error leaf receives the serialized `{ error, status
 * }` payload shape.
 *
 * ── THE APP LEVEL IS DELIBERATELY ABSENT, AND MUST STAY ABSENT ──────────────
 * `ClientRouteComposition.App` and `payload.appData` still exist and are still
 * carried; they are contracts owned elsewhere. They are simply not part of THIS
 * tree, because App is not part of the markup this tree hydrates against:
 *
 *  - Server-side, `render-page.ts`'s `wrapRootward` wraps the page leaf in
 *    `["layout", "app"]` (`render-page.ts:274`), so the document React renders
 *    is `App( Layout( Page ) )`.
 *  - The app root is the level that owns `<html>`/`<body>` and renders
 *    `<div id="root">{children}</div>` inside the body. So App CONTAINS the
 *    mount point — the markup actually inside `#root` is `Layout( Page )`.
 *  - `hydrate-page.tsx` mounts at `#root` and nowhere else.
 *
 * Composing App here would therefore hydrate a whole `<html>` document inside a
 * `<div>` the server filled with a layout: a guaranteed hydration mismatch. If
 * you arrived here from the optional `App?` on the composition type and are
 * about to "complete" the tree with it — that would be the defect, not the
 * omission.
 *
 * `load()` is awaited exactly ONCE per hydration and its result reused for all
 * levels — the composition arrives whole, so calling it per layout would be
 * one network waterfall per level for no new information.
 */
export async function buildHydratedTree(
  pages: readonly ClientPageEntry[],
  payload: HydrationDocumentPayloadSource,
): Promise<ReactNode> {
  const entry = findEntryByName(pages, payload.name);
  const composition = await loadClientRouteComposition(entry);
  const errorPageProps = payload.errorPage;
  const selectedPageModule =
    errorPageProps === undefined ? composition.Page : composition.ErrorPage;

  if (selectedPageModule === undefined) {
    throw new MissingHydrationErrorPageError(payload.name);
  }

  // Registration is the first lifecycle action after the real namespaces have
  // loaded. Keep server order: root/App, layouts outermost-to-innermost, page.
  // On the error path the selected error module replaces the ordinary Page in
  // that order; registering Page as well would run code the server did not run.
  // Component extraction and React element creation intentionally happen only
  // after every registration hook has completed synchronously.
  registerModules([
    ...(composition.App === undefined ? [] : [composition.App]),
    ...composition.layouts,
    selectedPageModule,
  ]);

  const { shared } = payload;
  let element: ReactNode;

  if (errorPageProps === undefined) {
    const Page = componentOf<HydratedPageProps>(selectedPageModule);
    element =
      Page === undefined
        ? null
        : createElement(Page, {
            data: payload.pageData,
            shared,
            params: payload.params ?? {},
          });
  } else {
    const ErrorPage = componentOf<SerializedErrorPageProps>(selectedPageModule);
    element =
      ErrorPage === undefined ? null : createElement(ErrorPage, errorPageProps);
  }

  // Innermost layout wraps the page, so walk the outermost-first list backwards.
  for (let index = composition.layouts.length - 1; index >= 0; index -= 1) {
    element = wrap(
      composition.layouts[index]!,
      payload.layoutData,
      shared,
      element,
    );
  }

  return element;
}
