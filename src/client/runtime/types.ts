import type { RegisterableModuleNamespace } from "../../register-modules";

/**
 * A real ESM namespace returned by dynamic import(), retained so universal
 * lifecycle exports and the default React component remain available together.
 */
export type ClientProjectedModule = Readonly<Record<string, unknown>> & RegisterableModuleNamespace;

export type ClientRouteComposition = {
  readonly Page: ClientProjectedModule;
  readonly layouts: readonly ClientProjectedModule[];
  readonly App?: ClientProjectedModule;
  /**
   * The app-owned error leaf projected for this route. Optional so registries
   * produced before `error.page.tsx` support remain valid byte-for-shape.
   * Presence does not create a route; the hydration payload decides whether
   * the server rendered this module instead of `Page`.
   */
  readonly ErrorPage?: ClientProjectedModule;
};

export type ClientRouteLoad = () => ClientRouteComposition | Promise<ClientRouteComposition>;

export type ClientPageEntry = {
  readonly type: "page";
  readonly name: string;
  readonly path: string;
  readonly load: ClientRouteLoad;
};

export type ClientRouteParams = Readonly<Record<string, string>>;

export type ClientRouteMatch = {
  readonly entry: ClientPageEntry;
  readonly params: ClientRouteParams;
  /**
   * The locale the matched path carried, under an active
   * `web.localeRouting.strategy` — the stripped prefix code, or the default
   * locale for a bare path under `"prefix-except-default"`. `undefined`
   * under strategy `"none"`, which is every caller before this field existed.
   */
  readonly locale?: string;
};
