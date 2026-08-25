import { expect } from "vitest";
import {
  OPTIONAL_OBJECT_PAYLOAD_KEYS,
  REQUIRED_PAYLOAD_KEYS,
} from "../../src/hydration-payload";

/**
 * Assert a serialized hydration payload's key set against the CONTRACT rather
 * than against a copy of it.
 *
 * Two properties, and they are not the same property:
 *
 * 1. Every REQUIRED key is present. Absent is malformed — a payload missing one
 *    is not a payload we render from.
 * 2. Nothing rides along that the contract does not name. This is the half an
 *    exact-equality assertion used to give us, and it is worth keeping: a key
 *    leaking onto the wire is how server-side data reaches the browser by
 *    accident.
 *
 * What it deliberately does NOT assert is that the optional keys are present.
 * `metadata` is absent for a page that exports none, and `params` is absent
 * from a payload written before rev. 3 — the server is right in both cases.
 */
export function expectHydrationPayloadKeys(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload);

  expect(keys).toEqual(expect.arrayContaining([...REQUIRED_PAYLOAD_KEYS]));

  const allowed: string[] = [...REQUIRED_PAYLOAD_KEYS, ...OPTIONAL_OBJECT_PAYLOAD_KEYS];
  const unexpected = keys.filter(key => !allowed.includes(key));

  expect(unexpected).toEqual([]);
}
