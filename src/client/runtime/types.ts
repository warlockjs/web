export type ClientProjectedModule = Readonly<Record<string, unknown>>;

export type ClientRouteComposition = {
  readonly Page: ClientProjectedModule;
  readonly layouts: readonly ClientProjectedModule[];
  readonly App?: ClientProjectedModule;
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
