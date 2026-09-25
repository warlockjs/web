import type { ActionFailureSignal } from "./settle-page-response";

/** The framework-internal action result that travels in the payload as `actionData`. */
export type ActionState<TData = unknown> = {
  action: string;
  status: number;
  ok: boolean;
  data?: TData;
  /** Seal `input` (dotted) → first message. */
  errors: Record<string, string>;
  /** `payload.message` plus errors for inputs no field claims. */
  formErrors: string[];
  /** Echoed on failure only; never files, never redacted names. */
  values?: Record<string, string | string[]>;
};

export type SealActionError = { input?: string; error?: string; message?: string };

/** Default `web.forms.redactValues`. `*` matches any run of characters. */
export const DEFAULT_REDACT_VALUES: readonly string[] = [
  "password",
  "password_confirmation",
  "*token*",
  "*secret*",
];

export type ToActionStateOptions = {
  action: string;
  /** `web.forms.redactValues`; defaults to `DEFAULT_REDACT_VALUES`. */
  redactValues?: readonly string[];
  /** The body input to echo on failure. */
  values?: Record<string, unknown>;
  /** Inputs a field will claim; other errors also reach `formErrors`. Omit to claim all. */
  claimedInputs?: readonly string[];
};

export type ActionStateSource =
  | { kind: "success"; data?: unknown; status?: number }
  | { kind: "signal"; signal: ActionFailureSignal }
  | { kind: "errors"; errors: readonly SealActionError[]; status?: number };

/** Bracket names (`address[city]`) become dotted (`address.city`). */
export function normalizeInputName(name: string): string {
  return name.replace(/\[([^\]]*)\]/g, ".$1").replace(/^\./, "");
}

function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${escaped}$`, "i").test(name);
}

/** Echo only string / string[] values, dropping files, objects and redacted names. */
function echoValues(
  values: Record<string, unknown> | undefined,
  patterns: readonly string[],
): Record<string, string | string[]> | undefined {
  if (!values) return undefined;

  const echoed: Record<string, string | string[]> = {};

  for (const [name, value] of Object.entries(values)) {
    if (patterns.some((pattern) => matchesPattern(name, pattern))) continue;

    if (typeof value === "string") {
      echoed[name] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      echoed[name] = String(value);
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      echoed[name] = value as string[];
    }
  }

  return echoed;
}

function foldErrors(
  errors: readonly SealActionError[],
  claimed: Set<string> | undefined,
): { errors: Record<string, string>; formErrors: string[] } {
  const map: Record<string, string> = {};
  const formErrors: string[] = [];

  for (const entry of errors) {
    const message = entry.error ?? entry.message;
    if (typeof message !== "string") continue;

    const input = entry.input ? normalizeInputName(entry.input) : "";

    if (!input) {
      formErrors.push(message);
      continue;
    }

    if (!(input in map)) map[input] = message;
    if (claimed && !claimed.has(input)) formErrors.push(message);
  }

  return { errors: map, formErrors };
}

/** A failure helper payload of `{ message?, errors? }`, errors as a Seal array or a record. */
function readPayload(payload: unknown): { message?: string; errors: SealActionError[] } {
  if (!payload || typeof payload !== "object") return { errors: [] };

  const { message, errors } = payload as { message?: unknown; errors?: unknown };
  const list: SealActionError[] = [];

  if (Array.isArray(errors)) {
    list.push(...(errors as SealActionError[]));
  } else if (errors && typeof errors === "object") {
    for (const [input, error] of Object.entries(errors)) {
      list.push({ input, error: Array.isArray(error) ? String(error[0]) : String(error) });
    }
  }

  return { message: typeof message === "string" ? message : undefined, errors: list };
}

/**
 * Pure: turn an action's outcome (returned data, a failure signal, or Seal
 * validation errors) into the `ActionState` the payload carries.
 */
export function toActionState(
  source: ActionStateSource,
  options: ToActionStateOptions,
): ActionState {
  if (source.kind === "success") {
    return {
      action: options.action,
      status: source.status ?? 200,
      ok: true,
      ...(source.data !== undefined ? { data: source.data } : {}),
      errors: {},
      formErrors: [],
    };
  }

  const claimed = options.claimedInputs
    ? new Set(options.claimedInputs.map(normalizeInputName))
    : undefined;
  let status: number;
  let data: unknown;
  let folded: ReturnType<typeof foldErrors>;

  if (source.kind === "signal") {
    const { message, errors } = readPayload(source.signal.payload);

    status = source.signal.statusCode;
    data = source.signal.payload;
    folded = foldErrors(errors, claimed);
    if (message !== undefined) folded.formErrors.unshift(message);
  } else {
    status = source.status ?? 422;
    folded = foldErrors(source.errors, claimed);
  }

  const values = echoValues(options.values, options.redactValues ?? DEFAULT_REDACT_VALUES);

  return {
    action: options.action,
    status,
    ok: false,
    ...(data !== undefined ? { data } : {}),
    errors: folded.errors,
    formErrors: folded.formErrors,
    ...(values ? { values } : {}),
  };
}
