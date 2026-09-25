import { href } from "./route-table";

/**
 * `href()` for a route name only known at runtime (a `to` prop typed as the
 * registry's name union, with params typed per name elsewhere). The typed
 * overload cannot be called with a union name plus a matching params object,
 * so this is the one sanctioned widening; unknown names still throw
 * `UnknownRouteNameError` at runtime.
 */
export function hrefByName(name: string, params?: object): string {
  return (href as (name: string, params?: object) => string)(name, params);
}
