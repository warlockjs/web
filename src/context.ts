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

export type PageContext<TRequest extends Request = Request> = CoreHttpContext<TRequest> & {
  shared: SharedContext;
  site?: PageSite;
};
