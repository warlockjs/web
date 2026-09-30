import type { ApiRouteRegistry, PageRouteRegistry } from "../index";

/** Values a generated route parameter can interpolate. */
export type RouteParamValue = string | number;

/** A generated page-route entry contributed through {@link PageRouteRegistry}. */
export type PageRouteDefinition = {
  path: string;
  params: object;
};

/** A generated API-route entry contributed through {@link ApiRouteRegistry}. */
export type ApiRouteDefinition = PageRouteDefinition & {
  method: string;
  /** Response bodies by HTTP status, present when the handler declares `responseSchema`. */
  response?: Readonly<Record<number, unknown>>;
};

declare const runtimeRouteBrand: unique symbol;

/**
 * An intentionally dynamic route name. Use {@link runtimeRoute} to opt out of
 * generated-name checking at a call site that cannot know its route until runtime.
 */
export type RuntimeRouteName = string & {
  readonly [runtimeRouteBrand]: true;
};

/** Mark one dynamically discovered route name without widening known route names to `string`. */
export function runtimeRoute(name: string): RuntimeRouteName {
  return name as RuntimeRouteName;
}

type RegistryName<Registry> = Extract<keyof Registry, string>;
type RegistryHasNames<Registry> = [RegistryName<Registry>] extends [never] ? false : true;
type RegistryEntry<Registry, Name extends string> = Name extends keyof Registry
  ? Registry[Name]
  : never;
type EntryParams<Entry> = Entry extends { params: infer Params extends object }
  ? Params
  : Record<string, RouteParamValue>;
type RequiredKeys<Value extends object> = {
  [Key in keyof Value]-?: {} extends Pick<Value, Key> ? never : Key;
}[keyof Value];
type TargetParams<Params extends object> =
  RequiredKeys<Params> extends never ? { params?: Params } : { params: Params };
type DynamicTarget = {
  name: RuntimeRouteName;
  params?: Record<string, RouteParamValue>;
};

/** Whether the application generated at least one precise page route entry. */
export type HasGeneratedPageRoutes = RegistryHasNames<PageRouteRegistry>;

/** Whether the application generated at least one precise API route entry. */
export type HasGeneratedApiRoutes = RegistryHasNames<ApiRouteRegistry>;

/** Page names emitted by the application's generated registry. */
export type RegisteredPageRouteName = RegistryName<PageRouteRegistry>;

/**
 * Page names whose generated registry entry carries `guard: "user"`: the page, a layout on its
 * chain, or the root declares `requireUser(...)` as a direct element of a literal
 * `config.middleware` array. `never` when no page is guarded (or no route types are generated).
 */
export type GuardedPageRouteName = {
  [Name in RegistryName<PageRouteRegistry>]: PageRouteRegistry[Name] extends { guard: "user" }
    ? Name
    : never;
}[RegistryName<PageRouteRegistry>];

/** Known generated page names, plus an explicit branded escape for dynamic-only names. */
export type PageRouteName = HasGeneratedPageRoutes extends true
  ? RegistryName<PageRouteRegistry> | RuntimeRouteName
  : string;

/** The parameter object associated with one page route name. */
export type PageRouteParams<Name extends PageRouteName> = Name extends RuntimeRouteName
  ? Record<string, RouteParamValue>
  : HasGeneratedPageRoutes extends true
    ? EntryParams<RegistryEntry<PageRouteRegistry, Extract<Name, string>>>
    : Record<string, RouteParamValue>;

type KnownPageRouteTarget = {
  [Name in RegistryName<PageRouteRegistry>]: { name: Name } & TargetParams<
    EntryParams<RegistryEntry<PageRouteRegistry, Name>>
  >;
}[RegistryName<PageRouteRegistry>];

/** A page navigation target whose `name` and `params` remain correlated. */
export type PageRouteTarget = HasGeneratedPageRoutes extends true
  ? KnownPageRouteTarget | DynamicTarget
  : { name: string; params?: Record<string, RouteParamValue> };

type ApiMethod<Name extends RegistryName<ApiRouteRegistry>> =
  RegistryEntry<ApiRouteRegistry, Name> extends { method: infer Method extends string }
    ? Method
    : string;
type IsAllMethod<Method extends string> = Uppercase<Method> extends "ALL" ? true : false;

/** API names emitted by the application's generated registry. */
export type RegisteredApiRouteName = RegistryName<ApiRouteRegistry>;

/** The registered request method for one API route. */
export type ApiRouteMethod<Name extends RegisteredApiRouteName> = ApiMethod<Name>;

/** Either conventional spelling of this route's generated canonical verb. */
export type ApiRouteMethodInput<Name extends RegisteredApiRouteName> =
  Uppercase<ApiMethod<Name>> | Lowercase<ApiMethod<Name>>;

/** Generated API names with a concrete browser request method. */
export type SubmittableApiRouteName = {
  [Name in RegisteredApiRouteName]: IsAllMethod<ApiMethod<Name>> extends true ? never : Name;
}[RegisteredApiRouteName];
/** Known generated API names that have an executable browser request method. */
export type ApiRouteName = HasGeneratedApiRoutes extends true
  ? SubmittableApiRouteName | RuntimeRouteName
  : string;

/** API names with a concrete published browser route. */
export type ApiHrefName = ApiRouteName;

/** The parameter object associated with one API route name. */
export type ApiRouteParams<Name extends ApiRouteName> = Name extends RuntimeRouteName
  ? Record<string, RouteParamValue>
  : HasGeneratedApiRoutes extends true
    ? EntryParams<RegistryEntry<ApiRouteRegistry, Extract<Name, string>>>
    : Record<string, RouteParamValue>;

/** The parameter object associated with an API URL target. */
export type ApiHrefParams<Name extends ApiHrefName> = Name extends RuntimeRouteName
  ? Record<string, RouteParamValue>
  : HasGeneratedApiRoutes extends true
    ? EntryParams<RegistryEntry<ApiRouteRegistry, Extract<Name, string>>>
    : Record<string, RouteParamValue>;

type KnownApiRouteTarget = {
  [Name in SubmittableApiRouteName]: {
    name: Name;
    method: ApiRouteMethodInput<Name>;
  } & TargetParams<EntryParams<RegistryEntry<ApiRouteRegistry, Name>>>;
}[SubmittableApiRouteName];

/** A submittable API target with its registered method and parameter shape. */
export type ApiRouteTarget = HasGeneratedApiRoutes extends true
  ? KnownApiRouteTarget | (DynamicTarget & { method: string })
  : { name: string; method: string; params?: Record<string, RouteParamValue> };

type ApiEntryResponses<Name extends string> = Name extends keyof ApiRouteRegistry
  ? ApiRouteRegistry[Name] extends { response: infer Responses extends object }
    ? Responses
    : Record<never, never>
  : Record<never, never>;

/**
 * The response bodies one API route declares through `handler.responseSchema`, keyed by HTTP
 * status. Empty for an undeclared or dynamic (`runtimeRoute`) route.
 */
export type ApiResponses<Name extends ApiRouteName> = ApiEntryResponses<Extract<Name, string>>;

/**
 * The body a route declares for one status (200 by default), or `unknown` when the route or the
 * status is not declared. Never `any`.
 */
export type ApiResponse<
  Name extends ApiRouteName,
  Status extends number = 200,
> = Status extends keyof ApiResponses<Name> ? ApiResponses<Name>[Status] : unknown;

type SuccessStatus<Responses> = {
  [Status in keyof Responses]: Status extends number
    ? `${Status}` extends `2${string}`
      ? Status
      : never
    : never;
}[keyof Responses];

/**
 * The union of every 2xx body a route declares, or `unknown` when it declares none. This is the
 * body type a named form submission resolves `onSuccess` and `data` with.
 */
export type ApiSuccessResponse<Name extends ApiRouteName> = [
  SuccessStatus<ApiResponses<Name>>,
] extends [never]
  ? unknown
  : ApiResponses<Name>[SuccessStatus<ApiResponses<Name>>];
