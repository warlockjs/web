import { useRef, useState } from "react";
import type { FormSubmitOptions } from "@mongez/react-form";
import { submitAction } from "../client/navigation/action-submitter";
import type { ActionSubmitOutcome } from "../client/navigation/action-submitter";
import { hrefByName } from "../routing/href-by-name";

export type UseSubmitActionOptions = {
  /** The NAME of a page action (sent as `_action`). */
  action?: string;
  /** Another page's route name; its action is resolved with `href()`. */
  to?: string;
  params?: Record<string, string | number>;
  onSuccess?: (outcome: ActionSubmitOutcome) => void;
  onError?: (actionData: Readonly<Record<string, unknown>>) => void;
};

export type UseSubmitActionResult<Schema = undefined> = {
  /** Pass as `onSubmit` of react-form's `<Form method="post">`. */
  submit: (context: FormSubmitOptions<Schema>) => Promise<void>;
  isLoading: boolean;
  formErrors: string[];
};

/** Submit a `@mongez/react-form` to the current page's action (or `to`'s). */
export function useSubmitAction<Schema = undefined>(
  options: UseSubmitActionOptions = {},
): UseSubmitActionResult<Schema> {
  const [isLoading, setLoading] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const pending = useRef<Promise<void> | null>(null);

  const submit = (context: FormSubmitOptions<Schema>): Promise<void> => {
    if (pending.current) return pending.current;

    const task = (async () => {
      setLoading(true);
      setFormErrors([]);

      try {
        const formData = context.formData as FormData;

        if (options.action !== undefined) formData.set("_action", options.action);

        const url =
          options.to !== undefined
            ? hrefByName(options.to, options.params)
            : `${window.location.pathname}${window.location.search}`;
        const outcome = await submitAction(url, formData);

        if (outcome === undefined) return;

        if (outcome.type === "error") {
          const state = outcome.actionData as {
            errors?: Record<string, string>;
            formErrors?: string[];
          };

          if (state.errors && Object.keys(state.errors).length > 0) {
            context.form.setErrors(state.errors);
          }
          setFormErrors(state.formErrors ?? []);
          options.onError?.(outcome.actionData);
        } else if (outcome.type === "success" || outcome.type === "redirected") {
          options.onSuccess?.(outcome);
        }
      } finally {
        setLoading(false);
        pending.current = null;
      }
    })();

    pending.current = task;

    return task;
  };

  return { submit, isLoading, formErrors };
}
