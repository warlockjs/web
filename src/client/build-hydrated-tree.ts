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
import { Component, createElement, type ComponentType, type ReactNode } from "react";
import type {
  HydrationDocumentPayloadSource,
  SerializedErrorPageProps,
} from "../hydration-payload";
import { registerModules } from "../register-modules";
import { renderBuiltInFallback } from "./built-in-error-fallback";
import { statusOf } from "./client-error-status";
import { ErrorPageRenderGuard } from "./error-page-render-guard";
import { installPayloadTranslations } from "./install-payload-translations";
import { reportClientError } from "./report-client-error";
import { loadClientRouteComposition } from "./runtime";
import { sanitizeClientError } from "./sanitize-client-error";
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

function findEntryByName(pages: readonly ClientPageEntry[], name: string): ClientPageEntry {
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

  return typeof component === "function" ? (component as ComponentType<Props>) : undefined;
}

/** Advances per built tree, so a boundary can tell a fresh swap from a re-render. */
let builtTreeCount = 0;

type LevelErrorBoundaryProps = {
  readonly children?: ReactNode;
  /** Moves on every built tree; clears a caught error without remounting the subtree. */
  readonly resetToken: number;
  readonly routeName: string;
  /** The level's own exported `ErrorBoundary`, when it has one. */
  readonly Boundary?: ComponentType<{ error: unknown }>;
  /** The route's app `error.page.tsx`, used by the page-leaf floor only. */
  readonly ErrorPage?: ComponentType<SerializedErrorPageProps>;
};

/**
 * The client half of a page/layout `ErrorBoundary` export. Mirrors the server:
 * the nearest boundary renders IN PLACE of the level it covers, while every
 * level rootward of it (the layouts) stays mounted. It renders no DOM of its
 * own, so wrapping never changes the markup being hydrated.
 */
export class LevelErrorBoundary extends Component<
  LevelErrorBoundaryProps,
  { error: unknown; caught: boolean }
> {
  public state = { error: undefined as unknown, caught: false };

  public static getDerivedStateFromError(error: unknown) {
    return { error, caught: true };
  }

  public componentDidCatch(error: unknown): void {
    reportClientError("an error was caught by a page/layout boundary", error, {
      kind: "boundary",
      pathname: typeof window === "undefined" ? undefined : window.location.pathname,
      routeName: this.props.routeName,
    });
  }

  public componentDidUpdate(previousProps: LevelErrorBoundaryProps): void {
    if (previousProps.resetToken !== this.props.resetToken && this.state.caught) {
      this.setState({ error: undefined, caught: false });
    }
  }

  public render(): ReactNode {
    if (!this.state.caught) return this.props.children;

    const { Boundary, ErrorPage } = this.props;
    const { error } = this.state;

    if (Boundary !== undefined) return createElement(Boundary, { error });

    if (ErrorPage !== undefined) {
      return createElement(ErrorPageRenderGuard, {
        ErrorPage,
        errorPageProps: { error: sanitizeClientError(error), status: statusOf(error) },
      });
    }

    return renderBuiltInFallback();
  }
}

function boundaryOf(module: ClientProjectedModule): ComponentType<{ error: unknown }> | undefined {
  const boundary = module.ErrorBoundary;

  return typeof boundary === "function"
    ? (boundary as ComponentType<{ error: unknown }>)
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
 * Compose the tree the server rendered inside `#vessel`: ordered layouts wrapping
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
 *    `<div id="vessel">{children}</div>` inside the body. So App CONTAINS the
 *    mount point — the markup actually inside `#vessel` is `Layout( Page )`.
 *  - `hydrate-page.tsx` mounts at `#vessel` and nowhere else.
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

  // Legacy payloads supply the registry copy before registration. Scoped
  // payloads stay in their route provider and never extend the registry.
  // Both modes already carry the server's required copy, so register() is
  // not required to reproduce it and cannot prove its provenance afterward.
  installPayloadTranslations(payload);

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
  const resetToken = (builtTreeCount += 1);
  const routeName = payload.name;
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
    element = ErrorPage === undefined ? null : createElement(ErrorPage, errorPageProps);
  }

  // The page leaf gets its own boundary (its `ErrorBoundary` export, else the
  // framework floor) INSIDE the layouts, so a page-level failure keeps them.
  // The error-page leaf is not wrapped: it is already the fallback.
  if (errorPageProps === undefined) {
    element = createElement(
      LevelErrorBoundary,
      {
        resetToken,
        routeName,
        Boundary: boundaryOf(selectedPageModule),
        ErrorPage:
          composition.ErrorPage === undefined
            ? undefined
            : componentOf<SerializedErrorPageProps>(composition.ErrorPage),
      },
      element,
    );
  }

  // Innermost layout wraps the page, so walk the outermost-first list backwards.
  for (let index = composition.layouts.length - 1; index >= 0; index -= 1) {
    const layout = composition.layouts[index]!;

    element = wrap(layout, payload.layoutData, shared, element);

    const Boundary = boundaryOf(layout);

    // Like the server, a layout's own `ErrorBoundary` replaces that layout and
    // everything under it, still inside the layouts rootward of it.
    if (Boundary !== undefined) {
      element = createElement(LevelErrorBoundary, { resetToken, routeName, Boundary }, element);
    }
  }

  return element;
}
