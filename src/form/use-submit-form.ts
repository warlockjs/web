import {
  http,
  type CancellablePromise,
  type Http,
  type HttpData,
  type HttpResult,
} from "@mongez/http";
import { useEffect, useRef, useState } from "react";
import type { FormSubmitOptions } from "@mongez/react-form";
import { clearPrefetchCache } from "../client/navigation/prefetch";
import { resolveApiRoute } from "../routing/named-api-routes";
import { interpolateRoutePath } from "../routing/route-path-interpolation";
import type { SubmitFormResult, UseSubmitFormOptions } from "./types";

function resolveTarget<Schema, Data>(
  options: UseSubmitFormOptions<Schema, Data>,
): { path: string; method: string } {
  if ("path" in options && options.path !== undefined)
    return { path: options.path, method: options.method ?? "POST" };
  const routeName = options.route;
  if (!routeName) throw new Error("useSubmitForm requires exactly one of { route } or { path }.");
  const named = resolveApiRoute(routeName);
  return { path: named.path, method: options.method ?? named.method };
}

function defaultFieldErrors(error: NonNullable<HttpResult<unknown>["error"]>): {
  fields: Record<string, string>;
  general: string[];
} {
  if (!error.body || typeof error.body !== "object") return { fields: {}, general: [] };
  const body = error.body as Record<string, unknown>;
  const fields: Record<string, string> = {};
  // A non-validation failure (a 429, say) still carries a `{ message }` worth showing.
  if (Array.isArray(body.errors) && error.isValidationError)
    for (const entry of body.errors) {
      if (!entry || typeof entry !== "object") continue;
      const { input, error: message } = entry as Record<string, unknown>;
      if (typeof input === "string" && typeof message === "string") fields[input] = message;
    }
  return { fields, general: typeof body.message === "string" ? [body.message] : [] };
}

function queryValues(
  values: Record<string, unknown>,
  query: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | (string | number)[] | null | undefined> {
  const result: Record<string, string | number | boolean | (string | number)[] | null | undefined> =
    {};
  for (const [key, value] of Object.entries(values)) {
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) &&
        value.every((item) => typeof item === "string" || typeof item === "number"))
    )
      result[key] = value as never;
    else
      throw new Error(
        `GET/HEAD form value ${JSON.stringify(key)} cannot be serialized as a query parameter.`,
      );
  }
  return { ...result, ...(query as typeof result | undefined) };
}

/** Submit a @mongez/react-form through the app's configured HTTP singleton. */
export function useSubmitForm<Schema = undefined, Data = unknown>(
  options: UseSubmitFormOptions<Schema, Data>,
): SubmitFormResult<Schema, Data> {
  const active = useRef<CancellablePromise<HttpResult<Data>> | null>(null);
  const pendingPromise = useRef<Promise<void> | null>(null);
  const pending = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const formRef = useRef<FormSubmitOptions<Schema>["form"] | null>(null);
  const assignedErrors = useRef<Record<string, string>>({});
  const [response, setResponse] = useState<HttpResult<Data> | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelled.current = true;
      active.current?.cancel("component unmounted");
    };
  }, []);

  const clearOwnedErrors = () => {
    const form = formRef.current;
    if (!form) return;
    for (const control of form.controls()) {
      const assigned = assignedErrors.current[control.name];
      if (assigned !== undefined && control.error === assigned) control.setError(null);
    }
    assignedErrors.current = {};
  };

  const submit = (context: FormSubmitOptions<Schema>): Promise<void> => {
    if (pendingPromise.current) return pendingPromise.current;
    pending.current = true;
    cancelled.current = false;
    clearOwnedErrors();
    formRef.current = context.form;
    if (mounted.current) setFormErrors([]);
    setLoading(true);
    const task = (async () => {
      try {
        if (
          (await options.beforeSubmit?.(context)) === false ||
          cancelled.current ||
          !mounted.current
        )
          return;
        const target = resolveTarget(options);
        const method = target.method.toUpperCase();
        const client: Http = options.client ?? http;
        const path = interpolateRoutePath(target.path, options.params, {
          isMissing: (value) => value === undefined || value === null,
          onMissingParameter: (parameterName) => {
            throw new Error(
              `Submit route ${JSON.stringify(target.path)} is missing path parameter ${JSON.stringify(parameterName)}.`,
            );
          },
        });
        const request =
          method === "GET" || method === "HEAD"
            ? client.request<Data>(method, path, undefined, {
                headers: options.headers,
                params: queryValues(
                  context.values as Record<string, unknown>,
                  options.query as Record<string, unknown> | undefined,
                ),
              })
            : client.request<Data>(method, path, context.formData as HttpData, {
                headers: options.headers,
                params: options.query,
              });
        active.current = request;
        const result = await request;
        // A submission may have changed what any prefetched page shows.
        clearPrefetchCache();
        if (!mounted.current || cancelled.current || active.current !== request) return;
        setResponse(result);
        if (result.error) {
          const mapped =
            typeof options.mapFieldErrors === "function"
              ? { fields: options.mapFieldErrors(result.error), general: [] }
              : options.mapFieldErrors === false
                ? { fields: {}, general: [] }
                : defaultFieldErrors(result.error);
          if (options.mapFieldErrors !== false) {
            const known = new Set(context.form.controls().map((control) => control.name));
            const assigned = Object.fromEntries(
              Object.entries(mapped.fields).filter(([name]) => known.has(name)),
            );
            const unmatched = Object.entries(mapped.fields)
              .filter(([name]) => !known.has(name))
              .map(([name, message]) => `${name}: ${message}`);
            if (Object.keys(assigned).length > 0) context.form.setErrors(assigned);
            assignedErrors.current = assigned;
            setFormErrors([...mapped.general, ...unmatched]);
          }
          try {
            await options.onError?.(result);
          } finally {
            if (mounted.current) await options.onComplete?.(result);
          }
        } else {
          try {
            await options.onSuccess?.(result);
          } finally {
            if (mounted.current) await options.onComplete?.(result);
          }
        }
      } finally {
        if (mounted.current) setLoading(false);
        active.current = null;
        pendingPromise.current = null;
        pending.current = false;
      }
    })();
    pendingPromise.current = task;
    return task;
  };

  return {
    submit,
    data: response?.data ?? null,
    error: response?.error ?? null,
    response,
    isLoading,
    reset: () => {
      clearOwnedErrors();
      setResponse(null);
      setFormErrors([]);
    },
    cancel: (reason?: string) => {
      cancelled.current = true;
      active.current?.cancel(reason);
    },
    formErrors,
  };
}
