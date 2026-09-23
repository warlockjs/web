import type { Http, HttpError, HttpResult, RequestOptions } from "@mongez/http";
import type { FormSubmitOptions } from "@mongez/react-form";

export type SubmitFormTarget = { route: string; path?: never } | { path: string; route?: never };

export type UseSubmitFormOptions<Schema = undefined, Data = unknown> = SubmitFormTarget & {
  method?: string;
  params?: Record<string, unknown>;
  query?: RequestOptions["params"];
  headers?: RequestOptions["headers"];
  client?: Http;
  beforeSubmit?: (context: FormSubmitOptions<Schema>) => boolean | void | Promise<boolean | void>;
  onSuccess?: (response: HttpResult<Data>) => void | Promise<void>;
  onError?: (response: HttpResult<Data>) => void | Promise<void>;
  onComplete?: (response: HttpResult<Data>) => void | Promise<void>;
  mapFieldErrors?: boolean | ((error: HttpError) => Record<string, string>);
};

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
