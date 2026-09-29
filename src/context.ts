import type { HttpContext as CoreHttpContext, Request } from "@warlock.js/core";
import type { SharedContext } from "./index";

export type HttpContext<TRequest extends Request = Request> = CoreHttpContext<TRequest>;

/** The selected multi-site identity; undefined for single-site requests. */
export type PageSite = {
  key: string;
  host: string;
  basePath: string;
  tenantKey?: string;
};

/**
 * The MATCHED page's route. Under `sites` core registers one catch-all per
 * method, so `request.route` is that catch-all; this is the page itself.
 */
export type PageRoute = Readonly<{
  name: string | undefined;
  path: string;
  params: Record<string, string>;
}>;

export type PageContext<TRequest extends Request = Request> = CoreHttpContext<TRequest> & {
  shared: SharedContext;
  site?: PageSite;
  route: PageRoute;
};
