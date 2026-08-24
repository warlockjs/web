/**
 * The page handler, as a named seam.
 *
 * This is the request handler `installPageRoutes` used to inline into its
 * `router.get(...)` call (`install-page-routes.ts:236-275` before this
 * extraction; the pre-extraction copy is `scratchpad/install-page-routes.ts.orig`).
 * The behaviour is unchanged, byte for byte — what changes is that it is now
 * a named, exported, independently constructible function instead of a closure
 * over eight ambient bindings of `installPageRoutes`.
 *
 * WHY IT TAKES `loadModule` AND NOT A `ViteDevServer`: loading a module is the
 * only capability the handler ever needed, and the two runtimes answer it
 * differently — dev goes through Vite's SSR graph
 * (`vite.ssrLoadModule`, `install-page-routes.ts:207`), production reads the
 * already-built page manifest (`page-manifest.ts`). Taking "how to load a
 * module" as an INPUT is what lets the same handler serve both, and what lets
 * a test construct it with a plain async function — no Vite, no dev server, no
 * `app/` directory on disk.
 *
 * Scope: this file creates a seam and nothing else. It does not implement
 * `type: "page"` routing, HTML error pages, or any other new capability.
 */
import type { Response } from "../../../core/src/http/response";
import type { HttpContext } from "../../../core/src/router/types";
import {
  DATA_RESPONSE_CONTENT_TYPE,
  isDataRequest,
  WARLOCK_DATA_REQUEST_HEADER,
} from "../routing/data-request";
import { buildHydrationPayload } from "./build-hydration-payload";
import type { BufferedCookie } from "./buffered-response";
import type { PageRouteEntry, PageTripleModule } from "./execute-page-request";
import { renderPageRequest } from "./render-page";

/**
 * How the handler obtains a page/layout/app module, by the same id
 * (`appFile`/`layoutFile`/`pageFile`) the caller registered it under. In dev
 * this is `moduleId => vite.ssrLoadModule(moduleId)`; the connector already
 * owns the dev/prod split, so the handler never learns which one it got.
 */
export type PageModuleLoader = (moduleId: string) => Promise<unknown>;

export type PageRouteHandlerOptions = {
  /** The composed, registered route path — `composeRoutePath`'s output. */
  path: string;
  /** The resolved route name; shared namespace with API routes. */
  name: string;
  /** The single global app-root file, e.g. `<appSrcRoot>/web/root.tsx`. */
  appFile: string;
  /** The page module's id. */
  pageFile: string;
  /** The page's own-directory `layout.tsx`, when it has one. */
  layoutFile?: string | undefined;
  loadModule: PageModuleLoader;
  /** Browser module appended after the server-rendered document. */
  hydrationClientModuleUrl?: string;
  /** Same helper `dev-server.ts` exports — passed in, never imported. */
  applyBufferedCookie: (response: Response, cookie: BufferedCookie) => void;
};

export type PageRouteHandler = (context: HttpContext) => Promise<void>;

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function installHydrationClientModule(
  html: string,
  moduleUrl: string | undefined,
  nonce: string | undefined,
): string {
  if (moduleUrl === undefined || html === "") return html;

  const closingBodyIndex = html.lastIndexOf("</body>");
  if (closingBodyIndex === -1) {
    throw new Error(
      "installPageRoutes: cannot install the hydration client module because the rendered document has no closing </body> tag.",
    );
  }

  const nonceAttribute = nonce === undefined ? "" : ` nonce="${escapeHtmlAttribute(nonce)}"`;
  const script = `<script type="module"${nonceAttribute} src="${escapeHtmlAttribute(moduleUrl)}"></script>`;
  return `${html.slice(0, closingBodyIndex)}${script}${html.slice(closingBodyIndex)}`;
}

/**
 * Build the handler for ONE page route. Per request it loads the App + layout
 * + page triple (concurrently, in that order), renders the URL through
 * `renderPageRequest`, splices in the hydration module, applies the committed
 * cookies and headers, and flushes the document.
 *
 * No try/catch, deliberately: loader/render throws are already absorbed by the
 * pipeline's boundary machinery inside `renderPageRequest`, and anything that
 * escapes (a module-load failure, the missing-`</body>` throw above) belongs to
 * the router's error path — which is exactly where it went before.
 */
export function createPageRouteHandler(options: PageRouteHandlerOptions): PageRouteHandler {
  const {
    path,
    name,
    appFile,
    pageFile,
    layoutFile,
    loadModule,
    hydrationClientModuleUrl,
    applyBufferedCookie,
  } = options;

  return async ({ request, response }: HttpContext) => {
    const [appModule, layoutModule, ownPageModule] = await Promise.all([
      loadModule(appFile),
      layoutFile ? loadModule(layoutFile) : Promise.resolve({}),
      loadModule(pageFile),
    ]);

    const triple: PageRouteEntry["triple"] = {
      app: appModule as PageTripleModule,
      layout: layoutModule as PageTripleModule,
      page: ownPageModule as PageTripleModule,
    };

    const routes: PageRouteEntry[] = [{ path, name, triple }];

    // A DATA request runs everything above and below this line identically —
    // it is the same route, the same match and the same pipeline — and differs
    // only in what gets written at the end. Decided here, before the render, so
    // the branch is visibly about REPRESENTATION and not about behaviour.
    const wantsData = isDataRequest(request.header(WARLOCK_DATA_REQUEST_HEADER, undefined));

    const rendered = await renderPageRequest(request.path, {
      routes,
      createHttp: () => ({ request, response }),
    });

    if (wantsData) {
      // Cookies and headers FIRST, exactly as the document path does below and
      // for the same reason: a client navigation must be able to log a user in,
      // set a flash cookie or be redirected, and dropping those on this path
      // would make a navigation behave differently from a page load of the same
      // URL — the one difference this branch is not allowed to introduce.
      for (const cookie of rendered.cookies) {
        applyBufferedCookie(response, cookie);
      }

      response.headers(rendered.headers);

      // So a shared cache can never serve a document to a client that asked for
      // JSON, or the reverse. See `data-request.ts` on why this stays even
      // while page responses are `no-store`.
      response.header("Vary", WARLOCK_DATA_REQUEST_HEADER);

      // `bundle` is absent on exactly one path: nothing matched, so no pipeline
      // ran and there is no payload to build. Fastify already matched this
      // route to get here, so reaching it means `request.path` did not satisfy
      // the entry's own pattern — answered as the 404 it is, rather than
      // synthesising an empty payload the client would try to render as a page.
      if (rendered.bundle === undefined) {
        response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
        await response.send(JSON.stringify({ error: "not_found" }), rendered.status);

        return;
      }

      // SERIALIZED HERE, and handed over as a STRING on purpose.
      //
      // `response.send(object)` runs the body through core's `Response.parse`,
      // which recurses the object, calls `toJSON()` on anything that has one
      // (assigning `request` onto it as it goes) and rebuilds arrays. That is
      // the right behaviour for a controller returning Resources; it is the
      // wrong behaviour here, because the DOCUMENT path serializes this exact
      // object with a plain `JSON.stringify` into `#__WARLOCK_DATA__`. Routing
      // one path through a transformer and not the other is precisely the
      // drift `build-hydration-payload.ts` exists to prevent — the browser
      // would build one tree on a page load and a different one on a
      // navigation to the same URL.
      //
      // A string body also bypasses `parseBody()` entirely, so the content type
      // has to be declared rather than inferred from an object body.
      response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
      await response.send(JSON.stringify(buildHydrationPayload(rendered.bundle)), rendered.status);

      return;
    }

    const html = installHydrationClientModule(
      rendered.html,
      hydrationClientModuleUrl,
      hydrationClientModuleUrl === undefined ? undefined : request.nonce,
    );

    // THE single site that puts a committed cookie on the wire. The commit
    // stage used to mirror the same list onto the live response as well
    // (`commitBuffers`, execute-page-request.ts), and because fastify's
    // `setCookie` APPENDS rather than sets, every page response carried two
    // identical `Set-Cookie` headers — happy path included. The mirror's
    // cookie half is gone; this loop is what remains, and it is the right
    // one: it runs at stage 10a, after the render, alongside the headers and
    // the final status, so it applies the answer the pipeline actually
    // settled on rather than the one it had at stage 7.
    for (const cookie of rendered.cookies) {
      applyBufferedCookie(response, cookie);
    }

    response.headers(rendered.headers);

    await response.html(html, rendered.status);
  };
}
