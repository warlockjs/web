import {
  PAYLOAD_SCRIPT_ID,
  type HydrationDocumentPayloadSource,
} from "./components/document-context";

export type { HydrationDocumentPayloadSource } from "./components/document-context";
export type {
  ErrorPageProps,
  SerializedErrorPageProps,
  SerializedPageError,
} from "./components/document-context";

/**
 * Exported so a payload-shape assertion can be written against the contract
 * itself. A spec that hardcodes its own copy of this list silently becomes a
 * claim about a PAST revision — that is exactly how the rev. 3 keys landed with
 * two specs still asserting the rev. 2 shape.
 */
export const REQUIRED_PAYLOAD_KEYS = [
  "appData",
  "layoutData",
  "pageData",
  "shared",
  "name",
] as const;

const ABSENT_PAYLOAD_MESSAGE =
  `Warlock hydration payload is absent: #${PAYLOAD_SCRIPT_ID}, owned by ` +
  "web/src/components/document-context.ts, was not found.";
const MALFORMED_PAYLOAD_MESSAGE =
  `Warlock hydration payload was found at #${PAYLOAD_SCRIPT_ID} but could not be read.`;

function malformedPayload(): never {
  throw new Error(MALFORMED_PAYLOAD_MESSAGE);
}

/**
 * The keys that are allowed to be ABSENT but not allowed to be wrong.
 *
 * `metadata`, `params` and `errorPage` are optional because the server is right
 * always produce them — a page with no `metadata` export resolves none, and a
 * older payload carries none of these additions. Failing a whole page over an
 * absent accessor would turn a compatible payload into a blank screen, so
 * absence is accepted.
 *
 * Present-but-not-an-object is a different claim entirely: it means something
 * produced a payload with these names meaning something else, and every reader
 * downstream would then be indexing a string. That is MALFORMED under the same
 * rule the required keys live by, so it throws. Arrays included — `typeof []`
 * is `"object"`, and an array of params is not params.
 */
export const OPTIONAL_OBJECT_PAYLOAD_KEYS = ["metadata", "params", "errorPage"] as const;

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactStringKeys(
  value: Record<PropertyKey, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);

  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

/**
 * Validate the explicit serialization boundary, not an `Error` instance.
 * `JSON.stringify(new Error("boom"))` is normally `{}` because its useful
 * fields are non-enumerable; accepting that would hydrate an error page with a
 * different contract from the one the server rendered.
 */
function requireErrorPagePayload(value: unknown): void {
  if (!isPlainObject(value)) malformedPayload();

  const errorPage = value as Record<PropertyKey, unknown>;

  if (!hasExactStringKeys(errorPage, ["error", "status"])) malformedPayload();
  if (!isPlainObject(errorPage.error)) malformedPayload();

  const error = errorPage.error as Record<PropertyKey, unknown>;

  if (!hasExactStringKeys(error, ["name", "message"], ["stack"])) malformedPayload();
  if (typeof error.name !== "string" || typeof error.message !== "string") {
    malformedPayload();
  }
  if (error.stack !== undefined && typeof error.stack !== "string") malformedPayload();

  if (
    typeof errorPage.status !== "number" ||
    !Number.isInteger(errorPage.status) ||
    errorPage.status < 500 ||
    errorPage.status > 599
  ) {
    malformedPayload();
  }
}

function requireHydrationPayload(value: unknown): HydrationDocumentPayloadSource {
  if (!isPlainObject(value)) malformedPayload();

  for (const key of REQUIRED_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) malformedPayload();
  }

  for (const key of OPTIONAL_OBJECT_PAYLOAD_KEYS) {
    const optional = (value as Record<string, unknown>)[key];

    if (optional !== undefined && !isPlainObject(optional)) malformedPayload();
  }

  const errorPage = (value as Record<string, unknown>).errorPage;
  if (errorPage !== undefined) requireErrorPagePayload(errorPage);

  return value as HydrationDocumentPayloadSource;
}

/**
 * Read the fixed payload script without changing the server-rendered root.
 *
 * Extra fields are ignored. The gate owns the FIVE required keys — absent or
 * malformed, both throw — plus a shape check on the three optional ones
 * ({@link OPTIONAL_OBJECT_PAYLOAD_KEYS}); it deliberately does not require
 * those to be present. `errorPage`, when present, is additionally validated as
 * one atomic `{ error, status }` selection with a serialized error and a 5xx.
 */
export function readHydrationPayload(documentNode: Document): HydrationDocumentPayloadSource {
  const element = documentNode.getElementById(PAYLOAD_SCRIPT_ID);

  if (element === null) throw new Error(ABSENT_PAYLOAD_MESSAGE);

  let parsed: unknown;

  try {
    parsed = JSON.parse(element.textContent ?? "");
  } catch {
    malformedPayload();
  }

  return requireHydrationPayload(parsed);
}
