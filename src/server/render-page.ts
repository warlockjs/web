import { createElement, type ComponentType, type ReactNode } from "react";
import { Response, type Request } from "@warlock.js/core";
import DefaultApp from "../components/default-app";
import {
  DocumentContext,
  escapePayload,
  PAYLOAD_SCRIPT_ID,
  type DocumentContextValue,
} from "../components/document-context";
import type { SharedContext } from "../index";
import { buildHydrationPayload } from "./build-hydration-payload";
import {
  hydrationErrorPageProps,
  resolveErrorPageMetadata,
  type ErrorPageModule,
  type ErrorPageModuleLoader,
} from "./error-page";
import { ERROR_PAGE_METADATA } from "./resolve-page-metadata";
import { registerModules, type RegisterableModuleNamespace } from "../runtime/register-modules";
import { markNonHydrating } from "./page-render-bundle";
import type { ServerErrorPageProps } from "../props";
import {
  buildErrorRecord,
  designateBoundary,
  executePageRequest,
  type BufferedCookie,
  type ExecutePageRequestOptions,
  type PageDataBundle,
  type PageErrorRecord,
  type PageLevelName,
  type PageResponseCommit,
  type PageRouteEntry,
  type PageRouteMatch,
  type PageTripleModule,
} from "./execute-page-request";

export { escapePayload, PAYLOAD_SCRIPT_ID };
export type { BufferedCookie };

/** Widens `PageDataBundle` with the stage 7 commit record — see `execute-page-request.ts`. */
type Bundle = PageDataBundle & { commit?: PageResponseCommit };

/** Reads the stage 7 commit into the lowercased header map `RenderedPage` carries. */
function committedHeaders(bundle: PageDataBundle): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const header of (bundle as Bundle).commit?.headers ?? []) {
    headers[header.key.toLowerCase()] = header.value;
  }

  return headers;
}

/** Reads the stage 7 commit into the cookie list `RenderedPage` carries. */
function committedCookies(bundle: PageDataBundle): BufferedCookie[] {
  return (bundle as Bundle).commit?.cookies ?? [];
}

/**
 * Pipeline stages 9–10: RENDER the page tree from the
 * data bundle stages 1–8 produced, then return finalized { html, status,
 * headers }. Stage 10 happens at the CALL SITE in two halves —
 * 10a the caller applies status + headers (the single live-response write,
 * after render, before anything flushes), 10b it flushes
 * the document. Nothing in this module writes the live response. It never
 * re-runs any earlier stage — `renderPage` calls `executePageRequest` and
 * everything here consumes its bundle as-is.
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
  /** Per-call overrides of the connected registry (tests, mostly). */
  routes?: readonly PageRouteEntry[];
  createHttp?: ExecutePageRequestOptions["createHttp"];
  /** Loaded only after the ordinary boundary chain has been exhausted. */
  loadErrorPage?: ErrorPageModuleLoader;
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
  /** Committed response cookies, in commit order — stage 7's `bundle.commit.cookies`. */
  cookies: BufferedCookie[];
  /**
   * The PAGE loader's data — `data.product.name` reads as the dx story
   * writes it. `unknown`: the pipeline never checks a loader's return shape.
   */
  data: unknown;
  /**
   * The full stages-1–8 bundle, for assertions beyond the page's own data.
   * Undefined ONLY on `renderPageRequest`'s no-match path: no route matched,
   * so no pipeline ran and there is no bundle — the 404 answer stands alone.
   * `renderPage` always carries one (its no-match throws instead).
   */
  bundle: PageDataBundle | undefined;
};

export type RenderPageFailureOptions = {
  name: string;
  path: string;
  request: Request;
  response: Response;
  thrown: unknown;
  loadErrorPage?: ErrorPageModuleLoader;
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
    .map((segment) => {
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

function errorPageElement(module: ErrorPageModule, props: ServerErrorPageProps): ReactNode {
  const ErrorPage = module.default as ((input: ServerErrorPageProps) => ReactNode) | undefined;
  if (!ErrorPage) {
    throw new Error("The application error.page.tsx module has no default export.");
  }
  return createElement(ErrorPage, props);
}

type LevelProps = {
  data: unknown;
  shared: Readonly<SharedContext> | undefined;
  children?: ReactNode;
};

/** The ordinary page leaf alone receives the route match's params. */
type PageLevelProps = {
  data: unknown;
  shared: Readonly<SharedContext> | undefined;
  params: Readonly<Record<string, string>>;
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
 * with no DOM.
 */
function buildPageElement(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
): ReactNode {
  return wrapRootward(triple, bundle, "page", buildLeaf(triple.page, bundle));
}

/**
 * The error path renders the DESIGNATED boundary in place of the level it
 * covers, still wrapped by every level rootward of it — a page-level throw
 * keeps its App and Layout chrome, whose data survived the settle rules
 * (P1 §4: fulfilled sibling data stays in the bundle).
 *
 * `record` is explicit rather than read from `bundle.error` — a render-time
 * throw (`finishRender`'s stage 9 escalation loop) designates a NEW boundary on the fly that the stage 1-8 bundle never saw.
 */
function buildBoundaryElement(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
  record: PageErrorRecord,
): ReactNode {
  const { boundary, error } = record;
  const Boundary = triple[boundary.boundaryLevel].ErrorBoundary as
    ((props: { error: unknown }) => ReactNode) | undefined;

  const element = Boundary
    ? createElement(Boundary, { error })
    : createElement(FrameworkRootBoundary, {});

  const wrapped = wrapRootward(triple, bundle, boundary.boundaryLevel, element);

  // "App" has no level rootward of it, so `wrapRootward` returns `wrapped`
  // unwrapped when the boundary covers the app level itself — but the
  // pipeline always emits a complete document, so the
  // framework default supplies the shell here even though the app's own
  // (broken) root is what's being bypassed.
  return boundary.boundaryLevel === "app"
    ? createElement(DefaultApp, { children: wrapped })
    : wrapped;
}

function buildLeaf(module: PageTripleModule, bundle: PageDataBundle): ReactNode {
  const Component = module.default as ((props: PageLevelProps) => ReactNode) | undefined;

  if (!Component) return null;

  return createElement(Component as ComponentType<PageLevelProps>, {
    data: bundle.pageData,
    shared: bundle.shared,
    params: bundle.route.params,
  });
}

function wrapRootward(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
  from: PageLevelName,
  leaf: ReactNode,
): ReactNode {
  const wrappers: PageLevelName[] =
    from === "page" ? ["layout", "app"] : from === "layout" ? ["app"] : [];

  let element = leaf;

  for (const level of wrappers) {
    const Component = triple[level].default as ((props: LevelProps) => ReactNode) | undefined;

    if (!Component) {
      // "App" is the root: no App export means no custom document, but the
      // pipeline always emits a complete one — the
      // framework default App supplies it. Layout has no such fallback: an
      // omitted layout default export stays a no-DOM passthrough,
      // unchanged from before.
      if (level === "app") {
        element = createElement(DefaultApp, { children: element });
      }

      continue;
    }

    element = createElement(Component as ComponentType<LevelProps>, {
      data: bundle[DATA_KEYS[level]],
      shared: bundle.shared,
      children: element,
    });
  }

  return element;
}

// ---------------------------------------------------------------------------
// Document assembly — stage 10 (10a apply + 10b flush) lives at the call site
// ---------------------------------------------------------------------------

/**
 * The root (App or the framework default) now ALWAYS renders a complete
 * `<html>…</html>` document itself — `<Head/>`/
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

/**
 * The real request/response pair `capturingCreateHttp` captured for this
 * call. It is used at the two orchestrator call sites to read the document
 * slots (`documentSlotsFrom`, below).
 */
type CapturedHttp = {
  request: Request;
  response: Response;
};

/**
 * Wrap the caller's createHttp to capture the real pair (for the document
 * slots, `documentSlotsFrom` below) and the matched entry (the only place a
 * URL-based caller learns which triple to render).
 */
function capturingCreateHttp(registry: PageRoutesRegistry): {
  state: { captured?: CapturedHttp; match?: PageRouteMatch };
  createHttp: ExecutePageRequestOptions["createHttp"];
} {
  const state: { captured?: CapturedHttp; match?: PageRouteMatch } = {};

  return {
    state,
    createHttp(match) {
      state.match = match;
      state.captured = registry.createHttp(match);

      return state.captured;
    },
  };
}

/**
 * The two request-derived document slots (`nonce`/`lang` on
 * `DocumentContextValue`), extracted at the orchestrator call sites
 * because `finishRender` no longer carries `captured` (D1). `dir` is not
 * here: core's Request has no dir-like field (checked
 * core/src/http/request.ts — only `nonce` at :177 and `locale` at :343
 * exist) — an app supplies `dir` via its own convention.
 */
type DocumentSlots = {
  nonce?: string;
  lang?: string;
};

/** Reads document slots directly from core's Request. */
function documentSlotsFrom(captured: CapturedHttp | undefined): DocumentSlots {
  const request = captured?.request;

  return { nonce: request?.nonce, lang: request?.locale };
}

async function finishRender(
  triple: PageRouteEntry["triple"],
  bundle: PageDataBundle,
  documentSlots: DocumentSlots,
  response: Response,
  loadErrorPage: ErrorPageModuleLoader | undefined,
): Promise<RenderedPage> {
  // Read from the stage 7 commit, never live off `response` — this function
  // writes (and now reads) the live response zero times. A bundle with no
  // commit (no loader ran at all) simply has no headers/cookies to report.
  const headers = committedHeaders(bundle);
  const cookies = committedCookies(bundle);

  // Middleware and validation short-circuits emit no document. Loader-returned
  // Response instances never reach this function.
  if (bundle.shortCircuit) {
    const status =
      bundle.shortCircuit.stage === "validation"
        ? bundle.shortCircuit.status
        : (bundle.shortCircuit.statusCode ?? 200);
    return {
      html: "",
      status,
      headers,
      cookies,
      data: bundle.pageData,
      bundle,
    };
  }

  // `Cache-Control` is NOT decided here. The final value — the floor, an
  // opted-in route's `public, max-age`, or the closed-by-default `no-store` —
  // is decided once, at the `create-page-route-handler.ts` seam, by
  // `applyResponseCacheFloor` (`response-cache-floor.ts`), identically for the
  // document and the data representation. Anything this function's `headers`
  // map put under `cache-control` is overwritten there on purpose: two sites
  // deciding this key is exactly the drift that seam exists to prevent.

  // ── stage 9 · RENDER ─────────────────────────────────────────────────────
  // Lazy import: react-dom is a peer used only on this path, so merely
  // loading the server barrel never requires it.
  const { renderToString } = await import("react-dom/server");

  // JSON.stringify omits object properties whose value is undefined. Loader
  // `<Head/>`/`<Scripts/>` read this context — metadata and the payload are
  // both already final by this point (stages 1-8 are done), so there is
  // nothing left for the root to await.
  //
  // The payload comes from `buildHydrationPayload` rather than being assembled
  // here, so that this document and the `_loader` route hand the browser the
  // SAME object. See that module for why the two must not drift.
  let documentValue: DocumentContextValue = {
    metadata: bundle.metadata,
    payload: buildHydrationPayload(bundle),
    nonce: documentSlots.nonce,
    lang: documentSlots.lang,
  };

  const renderWithContext = (element: ReactNode): string =>
    renderToString(
      createElement(DocumentContext.Provider, {
        value: documentValue,
        children: element,
      }),
    );

  // A boundary that throws while rendering escalates to
  // the next enclosing boundary rootward; if none survives, the framework's
  // last-resort terminal renders. `currentError` starts as whatever stage
  // 1-8 already designated (`bundle.error`, undefined for a normal page
  // render) and is replaced by each escalation — `bundle.error` itself is
  // never mutated, staying a truthful stage 1-8 record.
  let currentError = bundle.error;
  let renderTimeThrow = false;
  let body: string;

  const renderFrameworkRoot = (): string =>
    renderWithContext(
      createElement(DefaultApp, {
        children: createElement(FrameworkRootBoundary, {}),
      }),
    );
  const renderFrameworkAfterErrorPageFailure = (): string => {
    bundle.errorPage = undefined;
    bundle.metadata = ERROR_PAGE_METADATA;
    documentValue = {
      ...documentValue,
      metadata: bundle.metadata,
      payload: buildHydrationPayload(bundle),
    };
    return renderFrameworkRoot();
  };

  const renderErrorPage = async (
    thrown: unknown,
    serializableError: unknown = thrown,
  ): Promise<string | undefined> => {
    if (!loadErrorPage) return undefined;

    const props: ServerErrorPageProps = { error: thrown, status: 500 };
    const module = await loadErrorPage();
    registerModules([module as RegisterableModuleNamespace]);
    const errorPage = hydrationErrorPageProps(props, serializableError);
    bundle.errorPage = errorPage;
    bundle.metadata = resolveErrorPageMetadata(module, props);
    documentValue = {
      ...documentValue,
      metadata: bundle.metadata,
      payload: buildHydrationPayload(bundle),
    };
    return renderWithContext(wrapRootward(triple, bundle, "page", errorPageElement(module, props)));
  };

  for (;;) {
    try {
      // The application error page is the framework terminal, never a rival
      // to an authored boundary. It is reached only after no app boundary
      // exists (or after that boundary has itself thrown below).
      if (currentError?.boundary.boundaryLevel === "app" && !triple.app.ErrorBoundary) {
        try {
          body =
            (await renderErrorPage(
              currentError.originalError ?? currentError.error,
              currentError.error,
            )) ?? renderFrameworkRoot();
        } catch {
          body = renderFrameworkAfterErrorPageFailure();
        }
        renderTimeThrow = true;
        break;
      }

      const element = currentError
        ? buildBoundaryElement(triple, bundle, currentError)
        : buildPageElement(triple, bundle);

      body = renderWithContext(element);
      break;
    } catch (thrown) {
      renderTimeThrow = true;

      if (currentError?.boundary.boundaryLevel === "app") {
        // The floor: the app-level boundary's own render just threw, so
        // there is nothing rootward of `app` to escalate to (§2's "none
        // survives"). Render the framework's trivial boundary directly —
        // bypassing the app's ErrorBoundary/App component, since that is
        // what just failed — wrapped in DefaultApp so the response is still
        // a complete `<html>` document (default-app.tsx:22-46) rather than
        // a bare `<main>` fragment.
        try {
          body = (await renderErrorPage(thrown)) ?? renderFrameworkRoot();
        } catch {
          body = renderFrameworkAfterErrorPageFailure();
        }
        break;
      }

      // Escalate from the level rootward of whatever just threw — searching
      // from the SAME level would re-select the boundary that just failed.
      // A throw not yet attributable to a level (a normal page render, no
      // prior designation) starts the search at `page`.
      const throwingLevel: PageLevelName =
        currentError?.boundary.boundaryLevel === "layout"
          ? "app"
          : currentError
            ? "layout"
            : "page";

      currentError = buildErrorRecord(thrown, designateBoundary(throwingLevel, triple));
    }
  }

  // Status is chosen after render — the last thing that can change the
  // outcome — and RETURNED, never applied: `finishRender` writes the live
  // response zero times. The caller applies status + headers at one site and
  // flushes immediately after (stage 10a/10b). "The framework owns the status
  // whenever a boundary renders" (design/request-lifecycle.md stage 7): ANY
  // boundary — nested or app-level, discovered pre-render or escalated during
  // render — forces 500. The boundary's LEVEL only decides which component
  // renders, never the status; the committed status from stage 7
  // (`bundle.commit.statusCode`) stands only for a page with no error at all
  // — read off the commit, never off the live `response`, same as `headers`
  // above. No committed status (no loader called `setStatusCode`) is the
  // ordinary 200.
  const status = currentError ? 500 : ((bundle as Bundle).commit?.statusCode ?? 200);

  const html = emitDocument(body);

  return { html, status, headers, cookies, data: bundle.pageData, bundle };
}

/**
 * Render failures that happen before the page pipeline has a triple (notably a
 * module-load or registration throw). This deliberately owns one terminal
 * attempt: an error-page failure falls straight to FrameworkRootBoundary.
 *
 * There is no triple yet, so there is no trustworthy server composition for
 * the browser to hydrate against — every response this function produces is
 * marked `markNonHydrating` (page-render-bundle.ts), on both the bundle and
 * the document payload, whether or not it managed to render the app's own
 * `error.page.tsx`. A normal app error page reached through `finishRender`
 * renders inside a real triple and stays hydratable; this path never does.
 */
export async function renderPageFailure(options: RenderPageFailureOptions): Promise<RenderedPage> {
  const { request, response, name, path, thrown, loadErrorPage } = options;
  const bundle: PageDataBundle = markNonHydrating({
    route: { name, path, params: {}, query: {} },
  });
  // No pipeline ran (there is no triple), so there is no commit to read —
  // never a live `response.getHeaders()` read either; see `finishRender`.
  const headers: Record<string, string> = { "cache-control": "private" };

  const { renderToString } = await import("react-dom/server");
  const slots = documentSlotsFrom({ request, response });
  const frameworkPayload = markNonHydrating(buildHydrationPayload(bundle));
  let value: DocumentContextValue = {
    metadata: undefined,
    payload: frameworkPayload,
    nonce: slots.nonce,
    lang: slots.lang,
  };
  const renderWithContext = (element: ReactNode): string =>
    renderToString(createElement(DocumentContext.Provider, { value, children: element }));
  let body: string;

  try {
    if (!loadErrorPage) throw new Error("No application error page is configured.");
    const props: ServerErrorPageProps = { error: thrown, status: 500 };
    const module = await loadErrorPage();
    registerModules([module as RegisterableModuleNamespace]);
    const errorPage = hydrationErrorPageProps(props);
    bundle.errorPage = errorPage;
    value = {
      ...value,
      metadata: resolveErrorPageMetadata(module, props),
      payload: markNonHydrating({ ...frameworkPayload, errorPage }),
    };
    body = renderWithContext(
      createElement(DefaultApp, { children: errorPageElement(module, props) }),
    );
  } catch {
    bundle.errorPage = undefined;
    bundle.metadata = ERROR_PAGE_METADATA;
    value = {
      ...value,
      metadata: bundle.metadata,
      payload: markNonHydrating(buildHydrationPayload(bundle)),
    };
    body = renderWithContext(
      createElement(DefaultApp, {
        children: createElement(FrameworkRootBoundary, {}),
      }),
    );
  }

  return {
    html: emitDocument(body),
    status: 500,
    headers,
    cookies: [],
    data: undefined,
    bundle,
  };
}

// ---------------------------------------------------------------------------
// The orchestrators
// ---------------------------------------------------------------------------

export async function renderPage(
  routeName: string,
  options: RenderPageOptions = {},
): Promise<RenderedPage | Response> {
  const registry = requireRegistry(options);
  const entry = registry.routes.find((candidate) => candidate.name === routeName);

  if (!entry) {
    const known = registry.routes.map((candidate) => `"${candidate.name}"`).join(", ");

    throw new Error(
      `renderPage("${routeName}"): no route with that name ` +
        `(web/src/server/render-page.ts). Known route names: ${known}. ` +
        "Fix: use a name from the manifest, or connect the manifest that " +
        "declares this one.",
    );
  }

  const url = buildUrl(entry, options.params ?? {}, options.query ?? {});
  const { state, createHttp } = capturingCreateHttp(registry);

  const rendered = await executePageRequest({
    url,
    routes: registry.routes,
    createHttp,
    finish: (bundle) =>
      finishRender(
        entry.triple,
        bundle,
        documentSlotsFrom(state.captured),
        state.captured!.response,
        options.loadErrorPage,
      ),
  });

  if (!rendered) {
    throw new Error(
      `renderPage("${routeName}"): the built URL "${url}" did not match ` +
        "stage 1 (web/src/server/render-page.ts). The name resolved but the " +
        "matcher disagreed — that is a manifest bug, not a caller bug.",
    );
  }

  return rendered;
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
): Promise<RenderedPage | Response> {
  const registry = requireRegistry(options);
  const { state, createHttp } = capturingCreateHttp(registry);

  const rendered = await executePageRequest({
    url,
    routes: registry.routes,
    createHttp,
    finish: (bundle) =>
      finishRender(
        state.match!.entry.triple,
        bundle,
        documentSlotsFrom(state.captured),
        state.captured!.response,
        options.loadErrorPage,
      ),
  });

  if (!rendered) {
    return {
      html: "",
      status: 404,
      headers: {},
      cookies: [],
      data: undefined,
      bundle: undefined,
    };
  }

  // executePageRequest only produces a bundle after createHttp ran for the
  // match, so the captured entry is present whenever the bundle is.
  return rendered;
}
