/**
 * Multi-site page dispatch — ONE shared function for dev and production.
 *
 * In multi-site mode the installers do not register each page on the router.
 * They hand every page to this dispatcher's per-site table, and the dispatcher
 * registers exactly one catch-all handler per method (`/*`). Core matches that
 * route only when no application route matches: dev's `RouteRegistry` and
 * production's Fastify both sit on find-my-way, where static and parametric
 * routes beat a wildcard. Vite's middleware and the static-asset routes are
 * registered outside the router's registry, so they answer first.
 *
 * Path matching reuses the web's own matcher (`matchClientRoute`); this module
 * writes no matcher of its own.
 */
import { requestContext, type HttpContext, type Request, type Router } from "@warlock.js/core";
import { matchClientRoute } from "../client/runtime/matcher";
import type { ClientPageEntry } from "../client/runtime/types";
import {
  createSiteSelector,
  validateSitesAtBoot,
  type SiteSelectorOptions,
} from "../sites/site-selector";
import { composeRoutePath } from "../routing/compose-route-path";
import { routeIdentityKey } from "../routing/route-identity-key";
import { connectCurrentSite, type CurrentSite } from "../routing/site-url";
import type { SitesConfig } from "../sites/site-config.types";
import type { SharedContext } from "../index";
import type { PageSite } from "../context";
import type { PageRouteHandler } from "./create-page-route-handler";
import { NOT_FOUND_ROUTE_PATH } from "./not-found-page";

/** What `request.site` carries on a multi-site request. */
export type RequestSite = PageSite;

/** Internal hand-off from site selection to the page pipeline's ALS scope. */
// Registry symbol: in dev the connector and the page pipeline run in two
// module copies (Node and Vite SSR), and both must name the same slot.
export const RESOLVED_SITE_SHARED = Symbol.for("warlock.resolved-site-shared");

declare module "@warlock.js/core" {
  interface Request {
    /** The site serving this request; set only in multi-site mode. */
    site?: RequestSite;
    /** Resolver data for the page pipeline; deliberately absent from `request.site`. */
    [RESOLVED_SITE_SHARED]?: Partial<SharedContext>;
  }
}

export const SITE_DISPATCH_ROUTE_PATH = "/*";
export const SITE_DISPATCH_GET_NAME = "warlock.site-dispatch.get";
export const SITE_DISPATCH_POST_NAME = "warlock.site-dispatch.post";

type Method = "GET" | "POST";

type SiteTable = {
  entries: ClientPageEntry[];
  handlers: Map<string, PageRouteHandler>;
  files: Map<string, string>;
  notFound?: PageRouteHandler;
};

function requestPort(request: Request): string | undefined {
  const host = request.header("host");
  const match = typeof host === "string" ? host.trim().match(/:(\d+)$/) : undefined;
  const port = match?.[1];

  if (
    port === undefined ||
    (request.protocol === "https" && port === "443") ||
    (request.protocol === "http" && port === "80")
  )
    return undefined;

  return port;
}

function currentSiteFor(request: Request | undefined): CurrentSite | undefined {
  const site = request?.site;

  if (site === undefined || request === undefined) return undefined;

  const port = requestPort(request);
  return {
    ...site,
    protocol: `${request.protocol}:`,
    ...(port === undefined ? {} : { port }),
  };
}

export type SiteDispatch = {
  /** Adds one page registration (a path plus the handler single-site mode would register). */
  add(site: string, method: Method, path: string, handler: PageRouteHandler, sourceFile?: string): void;
  /** Sets the site's `*` not-found page handler. */
  setNotFound(site: string, handler: PageRouteHandler): void;
  /** Registers the one catch-all handler per method. Call once, after every `add`. */
  register(router: Router): void;
};

/** What the connector hands each installer in multi-site mode. */
export type SiteDispatchInstall = {
  dispatch: SiteDispatch;
  sites: SitesConfig;
};

export type SiteDispatchOptions = SiteSelectorOptions;

function tableOf(tables: Map<string, Map<Method, SiteTable>>, site: string, method: Method) {
  let byMethod = tables.get(site);

  if (!byMethod) {
    byMethod = new Map();
    tables.set(site, byMethod);
  }

  let table = byMethod.get(method);

  if (!table) {
      table = { entries: [], handlers: new Map(), files: new Map() };
    byMethod.set(method, table);
  }

  return table;
}

export function createSiteDispatch(options: SiteDispatchOptions): SiteDispatch {
  validateSitesAtBoot(options);

  const selector = createSiteSelector(options);
  const tables = new Map<string, Map<Method, SiteTable>>();
  const notFoundHandlers = new Map<string, PageRouteHandler>();

  const dispatch = (method: Method): PageRouteHandler => {
    return async (context: HttpContext) => {
      const { request, response } = context;
      const pathname = request.path.split("?")[0] || "/";

      // A resolver throw propagates: core's own error path answers 500.
      const selection = await selector.select({
        rawHost: request.baseRequest.hostname,
        path: pathname,
        request,
      });

      if (selection.kind === "not-found") {
        await response.send(
          { error: "Route not found", path: request.path, method: request.method },
          404,
        );

        return;
      }

      const table = tables.get(selection.site)?.get(method);
      const match = table === undefined ? null : matchClientRoute(table.entries, pathname);
      const handler =
        match === null || table === undefined
          ? notFoundHandlers.get(selection.site)
          : table.handlers.get(match.entry.path);

      if (handler === undefined) {
        await response.send(
          { error: "Route not found", path: request.path, method: request.method },
          404,
        );

        return;
      }

      applyParams(request, match?.params ?? {});

      request.site = {
        key: selection.site,
        host: selection.host,
        basePath: selection.basePath,
        ...(selection.resolution === undefined ? {} : { tenantKey: selection.resolution.key }),
      };

      // The resolver reads core's ALS at use time, so concurrent dispatches
      // cannot leak an origin into one another's server render.
      connectCurrentSite(() => currentSiteFor(requestContext.getRequest()));

      if (selection.resolution?.shared !== undefined) {
        Object.defineProperty(request, RESOLVED_SITE_SHARED, {
          value: selection.resolution.shared,
          configurable: true,
          enumerable: false,
        });
      }

      return handler(context);
    };
  };

  return {
    add(site, method, path, handler, sourceFile) {
      const table = tableOf(tables, site, method);

      table.entries.push({ type: "page", name: `${site}:${path}`, path, load: async () => ({}) as never });
      table.handlers.set(path, handler);
      if (sourceFile !== undefined) table.files.set(path, sourceFile);
    },
    setNotFound(site, handler) {
      notFoundHandlers.set(site, handler);
    },
    register(router) {
      const appRoutes = router.list().filter(route => !route.isPage);
      const shadowed: string[] = [];

      for (const [site, methods] of tables) {
        for (const [method, table] of methods) {
          for (const entry of table.entries) {
            const pageIdentity = routeIdentityKey({ method, path: entry.path });
            const appRoute = appRoutes.find(
              route =>
                route.method === method &&
                routeIdentityKey({ method: route.method, path: route.path }) === pageIdentity,
            );

            if (appRoute !== undefined) {
              const file = table.files.get(entry.path) ?? `<${site}:${entry.path}>`;
              shadowed.push(
                `${file} is shadowed by application route ${method} ${appRoute.path}: this page can never be reached.`,
              );
            }
          }
        }
      }

      if (shadowed.length > 0) throw new Error(`Shadowed web pages:\n${shadowed.join("\n")}`);

      router.get(SITE_DISPATCH_ROUTE_PATH, dispatch("GET"), {
        name: SITE_DISPATCH_GET_NAME,
        isPage: true,
      });
      router.post(SITE_DISPATCH_ROUTE_PATH, dispatch("POST"), {
        name: SITE_DISPATCH_POST_NAME,
        isPage: true,
      });
    },
  };
}

/**
 * Params are set the way core sets them for a matched route: on the base
 * request's `params` (what `parsePayload` copies) and on the parsed payload.
 * The catch-all's own `*` capture is dropped.
 */
function applyParams(request: Request, params: Readonly<Record<string, string>>): void {
  const base = request.baseRequest as { params?: Record<string, string> };

  base.params = { ...params };

  const current = request.params as Record<string, string>;

  for (const key of Object.keys(current)) delete current[key];

  for (const [key, value] of Object.entries(params)) request.setParam(key, value);
}

/**
 * The router the per-site install runs against. It exposes only what the page
 * installers call: `get`/`post` feed the site's table (prefixed with its
 * `basePath`; the `*` not-found route becomes the site's not-found page) and
 * `withSourceFile` just runs its callback.
 */
export function siteRegistrationRouter(
  dispatch: SiteDispatch,
  site: string,
  basePath: string,
): Router {
  let sourceFile: string | undefined;
  const facade = {
    get(path: string, handler: PageRouteHandler) {
      if (path === NOT_FOUND_ROUTE_PATH) {
        dispatch.setNotFound(site, handler);

        return;
      }

      dispatch.add(site, "GET", composeRoutePath(basePath, path), handler, sourceFile);
    },
    post(path: string, handler: PageRouteHandler) {
      dispatch.add(site, "POST", composeRoutePath(basePath, path), handler, sourceFile);
    },
    withSourceFile<T>(nextSourceFile: string, callback: () => T): T {
      const previousSourceFile = sourceFile;
      sourceFile = nextSourceFile;
      try {
        return callback();
      } finally {
        sourceFile = previousSourceFile;
      }
    },
    list: () => [],
  };

  return facade as unknown as Router;
}
