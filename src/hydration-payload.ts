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

function requireHydrationPayload(value: unknown): HydrationDocumentPayloadSource {
  if (value === null || typeof value !== "object") malformedPayload();

  for (const key of REQUIRED_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) malformedPayload();
  }

  return value as HydrationDocumentPayloadSource;
}

/**
 * Read the fixed payload script without changing the server-rendered root.
 * Extra fields are ignored; the wire gate owns only the five required keys.
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
