import {
  PAYLOAD_SCRIPT_ID,
  type HydrationDocumentPayloadSource,
} from "./components/document-context";

export type { HydrationDocumentPayloadSource } from "./components/document-context";

const REQUIRED_PAYLOAD_KEYS = [
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
 * `metadata` and `params` are optional because the server is right not to
 * always produce them — a page with no `metadata` export resolves none, and a
 * payload written by a build that predates these keys carries neither. Failing
 * a whole page over an absent accessor would turn a cosmetic gap into a blank
 * screen, so absence is accepted and the readers default it.
 *
 * Present-but-not-an-object is a different claim entirely: it means something
 * produced a payload with these names meaning something else, and every reader
 * downstream would then be indexing a string. That is MALFORMED under the same
 * rule the required keys live by, so it throws. Arrays included — `typeof []`
 * is `"object"`, and an array of params is not params.
 */
const OPTIONAL_OBJECT_PAYLOAD_KEYS = ["metadata", "params"] as const;

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  return value as HydrationDocumentPayloadSource;
}

/**
 * Read the fixed payload script without changing the server-rendered root.
 *
 * Extra fields are ignored. The gate owns the FIVE required keys — absent or
 * malformed, both throw — plus a shape check on the two optional ones
 * ({@link OPTIONAL_OBJECT_PAYLOAD_KEYS}); it deliberately does not require
 * those to be present.
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
