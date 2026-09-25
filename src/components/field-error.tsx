import { createElement } from "react";
import type { HTMLAttributes, ReactElement } from "react";
import { normalizeInputName } from "../server/action-state";
import { useActionData } from "./use-action-data";

export type FieldErrorProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** The input name; `address[city]` and `address.city` are the same field. */
  name: string;
  /** Only show this named action's errors. */
  action?: string;
};

/** The id `<Form>` wires to an errored input's `aria-describedby`. */
export function fieldErrorId(name: string): string {
  return `${normalizeInputName(name)}-error`;
}

/** Renders the field's action error message, or nothing when it has none. */
export function FieldError({ name, action, ...rest }: FieldErrorProps): ReactElement | null {
  const message = useActionData(action)?.errors[normalizeInputName(name)];

  if (message === undefined) return null;

  return createElement("span", { role: "alert", ...rest, id: fieldErrorId(name) }, message);
}
