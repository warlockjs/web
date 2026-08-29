import type { HttpContext as CoreHttpContext, Request } from "@warlock.js/core";
import type { SharedContext } from "./index";

export type HttpContext<TRequest extends Request = Request> = CoreHttpContext<TRequest>;

export type PageContext<TRequest extends Request = Request> = CoreHttpContext<TRequest> & {
  shared: SharedContext;
};
