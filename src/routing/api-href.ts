import { interpolateRoutePath } from "./route-path-interpolation";
import { queryStringOf } from "./query-string";
import { resolveApiRoute } from "./named-api-routes";
import type { RouteQuery } from "./route-table";
import type {
  ApiHrefName,
  ApiHrefParams,
  HasGeneratedApiRoutes,
  RuntimeRouteName,
} from "./route-types";

type ApiHrefOptions<Name extends ApiHrefName> = HasGeneratedApiRoutes extends true
  ? Name extends RuntimeRouteName
    ? { params?: ApiHrefParams<Name>; query?: RouteQuery }
    : {} extends ApiHrefParams<Name>
      ? { params?: ApiHrefParams<Name>; query?: RouteQuery }
      : { params: ApiHrefParams<Name>; query?: RouteQuery }
  : { params?: ApiHrefParams<Name>; query?: RouteQuery };

type ApiHrefArguments<Name extends ApiHrefName> =
  {} extends ApiHrefOptions<Name>
    ? [options?: ApiHrefOptions<Name>]
    : [options: ApiHrefOptions<Name>];

/** Resolve a generated API route name to its path, with the shared URL query grammar. */
export function apiHref<Name extends ApiHrefName>(
  name: Name,
  ...args: ApiHrefArguments<Name>
): string;
export function apiHref(
  name: string,
  options: { params?: object; query?: RouteQuery } = {},
): string {
  const route = resolveApiRoute(name);
  return (
    interpolateRoutePath(
      route.path,
      options.params as Readonly<Record<string, unknown>> | undefined,
      {
        onMissingParameter: (parameterName) => {
          throw new Error(
            `API href ${JSON.stringify(name)} is missing path parameter ${JSON.stringify(parameterName)}.`,
          );
        },
        rejectUnknownParameters: true,
        onUnknownParameters: (parameterNames) => {
          throw new Error(
            `API href ${JSON.stringify(name)} was given unknown path parameter${parameterNames.length === 1 ? "" : "s"} ${parameterNames.map((parameterName) => JSON.stringify(parameterName)).join(", ")}.`,
          );
        },
      },
    ) + queryStringOf(options.query)
  );
}
