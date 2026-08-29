import type { RegisterableModuleNamespace } from "../../runtime/register-modules";

/**
 * A real ESM namespace returned by dynamic import(), retained so universal
 * lifecycle exports and the default React component remain available together.
 */
export type ClientProjectedModule = Readonly<Record<string, unknown>> &
  RegisterableModuleNamespace;

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

export type ClientRouteLoad = () =>
  | ClientRouteComposition
  | Promise<ClientRouteComposition>;

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
};
