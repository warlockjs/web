import { createElement, useContext, useEffect, useRef } from "react";
import type { FormHTMLAttributes, SubmitEvent as ReactSubmitEvent, ReactElement } from "react";
import { submitAction } from "../client/navigation/action-submitter";
import type { ActionSubmitOutcome } from "../client/navigation/action-submitter";
import { hrefByName } from "../routing/href-by-name";
import { DocumentContext } from "./document-context";
import { fieldErrorId } from "./field-error";

export type FormProps = Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "method" | "onError"> & {
  /** The NAME of a page action (sent as hidden `_action`), not a URL. */
  action?: string;
  /** Another page's route name; its action is resolved with `href()`. */
  to?: string;
  params?: Record<string, string | number>;
  resetOnSuccess?: boolean;
  onSuccess?: (outcome: ActionSubmitOutcome) => void;
  onError?: (actionData: Readonly<Record<string, unknown>>) => void;
};

function currentUrl(form: HTMLFormElement): string {
  return form.getAttribute("action") ?? `${window.location.pathname}${window.location.search}`;
}

/**
 * A real `<form method="post">` that the navigation runtime enhances: with the
 * runtime connected the submit goes through the page-action pipeline and the
 * page updates in place; without it (no JS, or before hydration) the browser
 * posts natively and the server renders the result.
 */
export function Form({
  action,
  to,
  params,
  encType = "multipart/form-data",
  resetOnSuccess,
  onSuccess,
  onError,
  onSubmit,
  children,
  ...rest
}: FormProps): ReactElement {
  const ref = useRef<HTMLFormElement>(null);
  const actionData = useContext(DocumentContext)?.payload.actionData as
    | { errors?: Record<string, string> }
    | undefined;
  const errors = actionData?.errors;

  // Wire aria on errored inputs after render; `<FieldError>` owns the message id.
  useEffect(() => {
    const form = ref.current;

    if (!form || !errors) return;

    for (const element of Array.from(form.elements)) {
      const field = element as HTMLInputElement;
      const key = field.name?.replace(/\[([^\]]*)\]/g, ".$1").replace(/^\./, "");

      if (!key) continue;

      if (key in errors) {
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", fieldErrorId(key));
      } else if (field.getAttribute("aria-describedby") === fieldErrorId(key)) {
        field.removeAttribute("aria-invalid");
        field.removeAttribute("aria-describedby");
      }
    }
  }, [errors]);

  async function handleSubmit(event: ReactSubmitEvent<HTMLFormElement>): Promise<void> {
    onSubmit?.(event);

    if (event.defaultPrevented) return;

    const form = event.currentTarget;
    const submitter = event.nativeEvent.submitter;

    event.preventDefault();

    const outcome = await submitAction(currentUrl(form), new FormData(form, submitter));

    // No runtime connected: let the browser do what it would have done.
    if (outcome === undefined) {
      form.submit();

      return;
    }

    if (outcome.type === "success") {
      if (resetOnSuccess) form.reset();
      onSuccess?.(outcome);
    } else if (outcome.type === "redirected") {
      onSuccess?.(outcome);
    } else if (outcome.type === "error") {
      onError?.(outcome.actionData);
    }
  }

  return createElement(
    "form",
    {
      ...rest,
      ref,
      method: "post",
      encType,
      action: to !== undefined ? hrefByName(to, params) : undefined,
      onSubmit: handleSubmit,
    },
    action !== undefined
      ? createElement("input", { type: "hidden", name: "_action", value: action })
      : null,
    children,
  );
}
