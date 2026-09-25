/** The reserved body field carrying the action's name (`<button name="_action" value="remove">`). */
export const ACTION_FIELD = "_action";

export const DEFAULT_ACTION_NAME = "default";

/** Action names: `default` is the unnamed action, every other name matches this. */
const ACTION_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/** The slice of core's `Request` this helper reads. */
export type ActionInputRequest = { body?: unknown };

export type ResolvedActionInput = {
  /** The requested action name; `"default"` when the body names none. */
  name: string;
  /** `false` when `_action` is present but not a valid action name. */
  validName: boolean;
  /** The body minus `_action` — what action validation runs against (files included). */
  input: Record<string, unknown>;
};

/**
 * Pure: split a POST body into the action name and the validation input.
 * Params and query never join the input (design §2.3, D4). A repeated
 * `_action` field resolves to its first value.
 */
export function resolveActionInput(request: ActionInputRequest): ResolvedActionInput {
  const body =
    request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : {};
  const { [ACTION_FIELD]: rawName, ...input } = body;
  const first = Array.isArray(rawName) ? rawName[0] : rawName;

  if (first === undefined || first === null || first === "") {
    return { name: DEFAULT_ACTION_NAME, validName: true, input };
  }

  if (typeof first !== "string") return { name: DEFAULT_ACTION_NAME, validName: false, input };

  return {
    name: first,
    validName: first === DEFAULT_ACTION_NAME || ACTION_NAME_PATTERN.test(first),
    input,
  };
}
