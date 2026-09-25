import { useContext } from "react";
import type { ActionState } from "../server/action-state";
import { DocumentContext } from "./document-context";

type Awaitable<T> = T | Promise<T>;

/** The data one action (or a record of actions) returns, failure signals excluded. */
export type ActionData<TAction> = TAction extends (...args: never[]) => Awaitable<infer TResult>
  ? TResult
  : TAction extends Record<string, (...args: never[]) => Awaitable<unknown>>
    ? { [Name in keyof TAction]: ActionData<TAction[Name]> }[keyof TAction]
    : unknown;

/**
 * The current page's action outcome, or `undefined` before any submit. Reads
 * `actionData` from the document payload, so the no-JS render, a JS swap and a
 * JS 422 share one source. Pass `name` to see only that named action's state.
 */
export function useActionData<TAction = unknown>(
  name?: string,
): ActionState<ActionData<TAction>> | undefined {
  const state = useContext(DocumentContext)?.payload.actionData as
    | ActionState<ActionData<TAction>>
    | undefined;

  if (!state) return undefined;
  if (name !== undefined && state.action !== name) return undefined;

  return state;
}
