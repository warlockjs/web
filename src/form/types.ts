import type { Http, HttpError, HttpResult, RequestOptions } from "@mongez/http";
import type { FormSubmitOptions } from "@mongez/react-form";
import type {
  ApiRouteMethodInput,
  ApiSuccessResponse,
  ApiRouteParams,
  HasGeneratedApiRoutes,
  RouteParamValue,
  RuntimeRouteName,
  SubmittableApiRouteName,
} from "../routing/route-types";

type LegacyNamedSubmitTarget = HasGeneratedApiRoutes extends true
  ? never
  : { route: string; path?: never; method?: string; params?: Record<string, RouteParamValue> };
type TypedNamedSubmitTarget = HasGeneratedApiRoutes extends true
  ? | {
        [Name in SubmittableApiRouteName]: {} extends ApiRouteParams<Name>
          ? {
              route: Name;
              path?: never;
              method?: ApiRouteMethodInput<Name>;
              params?: ApiRouteParams<Name>;
            }
          : {
              route: Name;
              path?: never;
              method?: ApiRouteMethodInput<Name>;
              params: ApiRouteParams<Name>;
            };
      }[SubmittableApiRouteName]
    | {
        route: RuntimeRouteName;
        path?: never;
        method?: string;
        params?: Record<string, RouteParamValue>;
      }
  : never;
type PathSubmitTarget = {
  path: string;
  route?: never;
  method?: string;
  params?: Record<string, unknown>;
};

export type SubmitFormTarget = LegacyNamedSubmitTarget | TypedNamedSubmitTarget | PathSubmitTarget;

type SubmitFormBehavior<Schema, Data> = {
  query?: RequestOptions["params"];
  headers?: RequestOptions["headers"];
  client?: Http;
  beforeSubmit?: (context: FormSubmitOptions<Schema>) => boolean | void | Promise<boolean | void>;
  onSuccess?: (response: HttpResult<Data>) => void | Promise<void>;
  onError?: (response: HttpResult<Data>) => void | Promise<void>;
  onComplete?: (response: HttpResult<Data>) => void | Promise<void>;
  mapFieldErrors?: boolean | ((error: HttpError) => Record<string, string>);
};

export type UseSubmitFormOptions<Schema = undefined, Data = unknown> = SubmitFormTarget &
  SubmitFormBehavior<Schema, Data>;

/** One generated API route as a submit target; the route name alone fixes the method and params. */
type NamedRouteSubmitTarget<Name extends SubmittableApiRouteName> = {
  route: Name;
  path?: never;
  method?: ApiRouteMethodInput<Name>;
} & ({} extends ApiRouteParams<Name>
  ? { params?: ApiRouteParams<Name> }
  : { params: ApiRouteParams<Name> });

/**
 * Options for submitting to one generated API route by name. The response body is the route's
 * declared 2xx `responseSchema` body (`unknown` when it declares none).
 */
export type UseNamedSubmitFormOptions<
  Schema,
  Name extends SubmittableApiRouteName,
> = NamedRouteSubmitTarget<Name> & SubmitFormBehavior<Schema, ApiSuccessResponse<Name>>;

export type SubmitFormResult<Schema = undefined, Data = unknown> = {
  submit: (context: FormSubmitOptions<Schema>) => Promise<void>;
  data: Data | null;
  error: HttpError | null;
  response: HttpResult<Data> | null;
  isLoading: boolean;
  reset: () => void;
  cancel: (reason?: string) => void;
  formErrors: string[];
};
