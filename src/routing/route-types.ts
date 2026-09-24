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

/** The parameter object associated with one API route name. */
export type ApiRouteParams<Name extends ApiRouteName> = Name extends RuntimeRouteName
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
