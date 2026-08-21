import { createElement, type ReactNode } from "react";
import DefaultApp from "../components/default-app";
import {
  DocumentContext,
  escapePayload,
  PAYLOAD_SCRIPT_ID,
} from "../components/document-context";
import type { SharedContext } from "../index";
import type { BufferedCookie } from "./buffered-response";
import {
  executePageRequest,
  type ExecutePageRequestOptions,
  type PageDataBundle,
  type PageLevelName,
  type PageRouteEntry,
  type PageRouteMatch,
  type PageTripleModule,
} from "./execute-page-request";

export { escapePayload, PAYLOAD_SCRIPT_ID };

/**
 * Pipeline stages 9–10 (canon 20c425dd §3): RENDER the page tree from the
 * data bundle stages 1–8 produced, then EMIT the HTML document. This module
 * never re-runs any earlier stage — `renderPage` calls `executePageRequest`
 * and everything here consumes its bundle as-is.
 *
 * `renderPage` is deliberately double-duty (dx-differentiators.md §3): it is
 * the production orchestrator AND the test helper. Because a loader IS a
 * controller, `renderPage("products.details", { params: { id: "42" } })`
 * returns `{ html, status, headers, data }` in one call — asserting a page's
 * data and its response headers is a unit test, no browser, no server boot.
 */

// ---------------------------------------------------------------------------
// The routes seam (same pattern as connectPageContext: boot wiring, once)
// ---------------------------------------------------------------------------

export type PageRoutesRegistry = {
  routes: readonly PageRouteEntry[];
  /** Same contract as ExecutePageRequestOptions["createHttp"]. */
  createHttp: ExecutePageRequestOptions["createHttp"];
};

let pageRoutesRegistry: PageRoutesRegistry | undefined;

/**
 * Boot-time wiring so `renderPage(name, options)` can resolve a route NAME
 * without each call site carrying the manifest. Returns the previous registry
 * so tests can restore it. A per-call `routes`/`createHttp` override wins.
 */
export function connectPageRoutes(
  registry: PageRoutesRegistry | undefined,
): PageRoutesRegistry | undefined {
  const previous = pageRoutesRegistry;
  pageRoutesRegistry = registry;
  return previous;
}

// ---------------------------------------------------------------------------
// renderPage surface
// ---------------------------------------------------------------------------

export type RenderPageOptions = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  /**
   * Impersonation for tests: assigned to `request.user` right after the
   * request pair is constructed — `user` is a plain public property on core's
   * Request (core/src/http/request.ts:92) and this is exactly the write auth
   * middleware would have performed.
   */
  as?: unknown;
  /** Per-call overrides of the connected registry (tests, mostly). */
  routes?: readonly PageRouteEntry[];
  createHttp?: ExecutePageRequestOptions["createHttp"];
};

/**
 * `renderPageRequest` takes the URL itself, so `params`/`query` (the
 * name-based sugar buildUrl consumes) have no meaning here — everything else
 * is the same seam.
 */
export type RenderPageRequestOptions = Omit<RenderPageOptions, "params" | "query">;

export type RenderedPage = {
  /** The full document ("" when the pipeline short-circuited before render). */
  html: string;
  status: number;
  /** Committed response headers, lowercased key → value. */
  headers: Record<string, string>;
  /**
   * Committed cookies in commit order, attribute-faithful: each entry carries
   * the loader's raw value (pre-serialization) AND its options
   * (`httpOnly`/`secure`/`sameSite`/`path`/`expires`/…). Never flattened to a
   * name→value map — a map cannot express the attributes, and a Set-Cookie
   * built without them is a security defect, not a convenience.
   */
  cookies: BufferedCookie[];
  /** The PAGE loader's data — `data.product.name` reads as the dx story writes it. */
  data: any;
  /**
   * The full stages-1–8 bundle, for assertions beyond the page's own data.
   * Undefined ONLY on `renderPageRequest`'s no-match path: no route matched,
   * so no pipeline ran and there is no bundle — the 404 answer stands alone.
   * `renderPage` always carries one (its no-match throws instead).
   */
  bundle: PageDataBundle | undefined;
};

function requireRegistry(
  options: Pick<RenderPageOptions, "routes" | "createHttp">,
): PageRoutesRegistry {
  const routes = options.routes ?? pageRoutesRegistry?.routes;
  const createHttp = options.createHttp ?? pageRoutesRegistry?.createHttp;

  if (!routes || !createHttp) {
    throw new Error(
      "renderPage()/renderPageRequest() has no route registry connected " +
        "(web/src/server/render-page.ts). Both resolve against the page " +
        "manifest, which the server bootstrap owns. Fix: " +
        "call connectPageRoutes({ routes, createHttp }) at boot (tests: in " +
        "beforeAll), or pass { routes, createHttp } to this call.",
    );
  }

  return { routes, createHttp };
}

function buildUrl(
  entry: PageRouteEntry,
  params: Record<string, string>,
  query: Record<string, string>,
): string {
  const path = entry.path
    .split("/")
    .map(segment => {
      if (!segment.startsWith(":")) return segment;

      const name = segment.slice(1);
      const value = params[name];

      if (value === undefined) {
        throw new Error(
          `renderPage("${entry.name}"): route path "${entry.path}" needs ` +
            `param "${name}" and the call did not provide it ` +
            "(web/src/server/render-page.ts). Fix: pass it in " +
            `\`params: { ${name}: … }\`.`,
        );
      }

      return encodeURIComponent(value);
    })
    .join("/");

  const queryString = new URLSearchParams(query).toString();

  return queryString ? `${path}?${queryString}` : path;
}

// ---------------------------------------------------------------------------
// Stage 9 — RENDER
// ---------------------------------------------------------------------------

/**
 * The framework-owned terminal boundary (P1 §4: designation falls back to
 * `app` even when no level exports one — "the framework owns a root
 * boundary"). Deliberately generic: the error itself is server knowledge and
 * never serialized into the document.
 */
function FrameworkRootBoundary(): ReactNode {
  return createElement("main", { role: "alert" }, "Something went wrong.");
}

type LevelProps = {
  data: unknown;
  shared: Readonly<SharedContext> | undefined;
  children?: ReactNode;
};

const DATA_KEYS: Record<PageLevelName, "appData" | "layoutData" | "pageData"> = {
  app: "appData",
  layout: "layoutData",
  page: "pageData",
};

/**
 * Compose the tree root→leaf: `<App><Layout><Page/></Layout></App>`, each
 * level receiving ITS OWN loader data and the same sealed `shared` — the
 * exact props the M1 contract declares (web/src/props.ts) and never
 * request/response (the component also renders on a machine where neither
 * exists, props.ts:19-22).
 *
 * A level with no default export contributes no DOM and passes children
 * through — that is `layout.tsx` omitting its default export to be a guard
 * with no DOM (canon 20c425dd §5).
 */
function buildPageElement(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
): ReactNode {
  return wrapRootward(triple, bundle, "page", buildLeaf(triple.page, bundle, "page"));
}

/**
 * The error path renders the DESIGNATED boundary in place of the level it
 * covers, still wrapped by every level rootward of it — a page-level throw
 * keeps its App and Layout chrome, whose data survived the settle rules
 * (P1 §4: fulfilled sibling data stays in the bundle).
 */
function buildBoundaryElement(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
): ReactNode {
  const { boundary, error } = bundle.error!;
  const Boundary = triple[boundary.boundaryLevel].ErrorBoundary as
    | ((props: { error: unknown }) => ReactNode)
    | undefined;

  const element = Boundary
    ? createElement(Boundary, { error })
    : createElement(FrameworkRootBoundary, {});

  const wrapped = wrapRootward(triple, bundle, boundary.boundaryLevel, element);

  // "App" has no level rootward of it, so `wrapRootward` returns `wrapped`
  // unwrapped when the boundary covers the app level itself — but the
  // pipeline always emits a complete document (Suki, room seq 1205), so the
  // framework default supplies the shell here even though the app's own
  // (broken) root is what's being bypassed.
  return boundary.boundaryLevel === "app"
    ? createElement(DefaultApp, { children: wrapped })
    : wrapped;
}

function buildLeaf(
  module: PageTripleModule,
  bundle: PageDataBundle,
  level: PageLevelName,
): ReactNode {
  const Component = module.default as ((props: LevelProps) => ReactNode) | undefined;

  if (!Component) return null;

  return createElement(Component as any, {
    data: bundle[DATA_KEYS[level]],
    shared: bundle.shared,
  });
}

function wrapRootward(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
  from: PageLevelName,
  leaf: ReactNode,
): ReactNode {
  const wrappers: PageLevelName[] = from === "page" ? ["layout", "app"] : from === "layout" ? ["app"] : [];

  let element = leaf;

  for (const level of wrappers) {
    const Component = triple[level].default as ((props: LevelProps) => ReactNode) | undefined;

    if (!Component) {
      // "App" is the root: no App export means no custom document, but the
      // pipeline always emits a complete one (Suki, room seq 1205) — the
      // framework default App supplies it. Layout has no such fallback: an
      // omitted layout default export stays a no-DOM passthrough (canon
      // 20c425dd §5), unchanged from before.
      if (level === "app") {
        element = createElement(DefaultApp, { children: element });
      }

      continue;
    }

    element = createElement(Component as any, {
      data: bundle[DATA_KEYS[level]],
      shared: bundle.shared,
      children: element,
    });
  }

  return element;
}

// ---------------------------------------------------------------------------
// Stage 10 — EMIT
// ---------------------------------------------------------------------------

/**
 * The root (App or the framework default) now ALWAYS renders a complete
 * `<html>…</html>` document itself (Suki, room seq 1205) — `<Head/>`/
 * `<Scripts/>` read the metadata/payload from `DocumentContext` (provided
 * around the element in `finishRender`, below) and emit real elements.
 * There is nothing left for this stage to assemble by string surgery; it
 * only prepends the doctype `renderToString` never includes.
 */
function emitDocument(body: string): string {
  return "<!DOCTYPE html>" + body;
}

// ---------------------------------------------------------------------------
// The shared tail (stages 9–10) — both orchestrators end here
// ---------------------------------------------------------------------------

type CapturedHttp = { request: any; response: any };

/**
 * Wrap the caller's createHttp to capture the real pair (for the
 * short-circuit status + the document's default header), the matched entry
 * (the only place a URL-based caller learns which triple to render), and to
 * apply `as` — `user` is a plain public property on core's Request
 * (core/src/http/request.ts:92), exactly the write auth middleware performs.
 */
function capturingCreateHttp(
  registry: PageRoutesRegistry,
  as: unknown,
): {
  state: { captured?: CapturedHttp; match?: PageRouteMatch };
  createHttp: ExecutePageRequestOptions["createHttp"];
} {
  const state: { captured?: CapturedHttp; match?: PageRouteMatch } = {};

  return {
    state,
    createHttp(match) {
      state.match = match;
      state.captured = registry.createHttp(match);

      if (as !== undefined) state.captured.request.user = as;

      return state.captured;
    },
  };
}

async function finishRender(
  triple: PageRouteEntry["triple"],
  bundle: PageDataBundle,
  captured: CapturedHttp | undefined,
): Promise<RenderedPage> {
  const headers: Record<string, string> = {};

  for (const header of bundle.commit?.headers ?? []) {
    headers[header.key.toLowerCase()] = header.value;
  }

  // The commit already deduplicated per name and ordered root→leaf
  // (execute-page-request.ts settle/commit) — pass it through untransformed so
  // every attribute survives to the caller's Set-Cookie.
  const cookies: BufferedCookie[] = bundle.commit?.cookies ?? [];

  // Short-circuit paths emit no document: the status IS the answer
  // (redirect/notFound/guard/422 — P1 §4), nothing renders to describe.
  if (bundle.shortCircuit) {
    const status =
      bundle.shortCircuit.stage === "validation"
        ? bundle.shortCircuit.status
        : bundle.shortCircuit.stage === "loaders"
          ? bundle.shortCircuit.statusCode
          : (captured?.response.statusCode ?? 200);

    return { html: "", status, headers, cookies, data: bundle.pageData, bundle };
  }

  // ── stage 9 · RENDER ────────────────────────────────────────────────────
  // Lazy import: react-dom is a peer used only on this path, so merely
  // loading the server barrel never requires it.
  const { renderToString } = await import("react-dom/server");

  const element = bundle.error
    ? buildBoundaryElement(triple, bundle)
    : buildPageElement(triple, bundle);

  // `<Head/>`/`<Scripts/>` read this context — metadata and the payload are
  // both already final by this point (stages 1-8 are done), so there is
  // nothing left for the root to await.
  const withContext = createElement(DocumentContext.Provider, {
    value: {
      metadata: bundle.metadata,
      payload: {
        appData: bundle.appData,
        layoutData: bundle.layoutData,
        pageData: bundle.pageData,
        shared: bundle.shared,
      },
    },
    children: element,
  });

  const body = renderToString(withContext as any);

  // ── stage 10 · EMIT ─────────────────────────────────────────────────────
  // README rule 8, the framework's half: every document this pipeline
  // produces is `Cache-Control: private` unless a loader's committed headers
  // already answered for the key — closed by default, not heuristically
  // cacheable. Applied to the REAL response, same write path as the commit.
  if (headers["cache-control"] === undefined) {
    headers["cache-control"] = "private";
    captured?.response.header("Cache-Control", "private");
  }

  const html = emitDocument(body);

  // On the boundary path the framework owns the status — P1's commit already
  // forced 500 (execute-page-request.ts:517); everything else is the
  // committed status or the document default.
  const status = bundle.error ? (bundle.commit?.statusCode ?? 500) : (bundle.commit?.statusCode ?? 200);

  return { html, status, headers, cookies, data: bundle.pageData, bundle };
}

// ---------------------------------------------------------------------------
// The orchestrators
// ---------------------------------------------------------------------------

export async function renderPage(
  routeName: string,
  options: RenderPageOptions = {},
): Promise<RenderedPage> {
  const registry = requireRegistry(options);
  const entry = registry.routes.find(candidate => candidate.name === routeName);

  if (!entry) {
    const known = registry.routes.map(candidate => `"${candidate.name}"`).join(", ");

    throw new Error(
      `renderPage("${routeName}"): no route with that name ` +
        `(web/src/server/render-page.ts). Known route names: ${known}. ` +
        "Fix: use a name from the manifest, or connect the manifest that " +
        "declares this one.",
    );
  }

  const url = buildUrl(entry, options.params ?? {}, options.query ?? {});
  const { state, createHttp } = capturingCreateHttp(registry, options.as);

  const bundle = await executePageRequest({ url, routes: registry.routes, createHttp });

  if (!bundle) {
    throw new Error(
      `renderPage("${routeName}"): the built URL "${url}" did not match ` +
        "stage 1 (web/src/server/render-page.ts). The name resolved but the " +
        "matcher disagreed — that is a manifest bug, not a caller bug.",
    );
  }

  return finishRender(entry.triple, bundle, state.captured);
}

/**
 * The URL-based sibling of `renderPage` — the production render surface: a
 * real HTTP server has a URL, not a route name. The url goes STRAIGHT to
 * executePageRequest's stage-1 matcher (no buildUrl), then the same shared
 * tail renders and emits.
 *
 * No-match here is NOT the manifest bug renderPage throws on: an arbitrary
 * URL matching no route is a legitimate 404, and a server must ANSWER it —
 * `{ html: "", status: 404 }` with an undefined `bundle` (see RenderedPage).
 */
export async function renderPageRequest(
  url: string,
  options: RenderPageRequestOptions = {},
): Promise<RenderedPage> {
  const registry = requireRegistry(options);
  const { state, createHttp } = capturingCreateHttp(registry, options.as);

  const bundle = await executePageRequest({ url, routes: registry.routes, createHttp });

  if (!bundle) {
    return { html: "", status: 404, headers: {}, cookies: [], data: undefined, bundle: undefined };
  }

  // executePageRequest only produces a bundle after createHttp ran for the
  // match, so the captured entry is present whenever the bundle is.
  return finishRender(state.match!.entry.triple, bundle, state.captured);
}
