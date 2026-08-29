import { describe, expect, it } from "vitest";
import { PAYLOAD_SCRIPT_ID } from "./components/document-context";
import { readHydrationPayload } from "./hydration-payload";
import { buildHydrationPayload } from "./server/build-hydration-payload";
import type { PageDataBundle } from "./server/execute-page-request";

function makeDocument(scriptTextContent: string | null): Document {
  return {
    getElementById(id: string) {
      if (id !== PAYLOAD_SCRIPT_ID) return null;
      if (scriptTextContent === null) return null;
      return { textContent: scriptTextContent } as unknown as HTMLElement;
    },
  } as unknown as Document;
}

const fullPayload = {
  appData: { a: 1 },
  layoutData: { l: 1 },
  pageData: { p: 1 },
  shared: { s: 1 },
  name: "home",
};

const serializedErrorPage = {
  error: {
    name: "TypeError",
    message: "Cannot read properties of undefined",
    stack: "TypeError: Cannot read properties of undefined\n    at home.page.tsx:10:3",
  },
  status: 500,
};

describe("readHydrationPayload", () => {
  it("parses and returns a payload object with all five keys", () => {
    const documentNode = makeDocument(JSON.stringify(fullPayload));

    expect(readHydrationPayload(documentNode)).toEqual(fullPayload);
  });

  it("throws the malformed message when name is missing", () => {
    const { name, ...withoutName } = fullPayload;

    const documentNode = makeDocument(JSON.stringify(withoutName));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the absent message when the script element is not found", () => {
    const documentNode = makeDocument(null);

    expect(() => readHydrationPayload(documentNode)).toThrow(
      new RegExp(`Warlock hydration payload is absent: #${PAYLOAD_SCRIPT_ID}`),
    );
  });

  it("throws the malformed message when the script content is not valid JSON", () => {
    const documentNode = makeDocument("not json");

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the malformed message when another required key is missing", () => {
    const { shared, ...withoutShared } = fullPayload;

    const documentNode = makeDocument(JSON.stringify(withoutShared));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  /**
   * `metadata`, `params` and `errorPage` are OPTIONAL: absent is a valid
   * payload, wrong-typed is not.
   *
   * They are ungated on purpose. The five gated keys are the ones the browser
   * cannot build a page without — no `name`, no page to look up; no `shared`,
   * no state to hydrate — so their absence has to be a loud failure. A page
   * that exports no `metadata` produces none (`bundle.metadata` is optional at
   * `server/execute-page-request.ts:296`), so requiring the key would make the
   * gate throw on a payload the server is right to have produced.
   */
  it("accepts an ordinary payload without metadata, params or errorPage", () => {
    const documentNode = makeDocument(JSON.stringify(fullPayload));

    expect(() => readHydrationPayload(documentNode)).not.toThrow();
  });

  it("returns metadata and params when the payload carries them", () => {
    const withBoth = {
      ...fullPayload,
      metadata: { title: "Contact us" },
      params: { id: "42" },
    };

    const documentNode = makeDocument(JSON.stringify(withBoth));

    expect(readHydrationPayload(documentNode)).toEqual(withBoth);
  });

  it("returns a JSON-round-tripped serialized error-page selection", () => {
    const withErrorPage = { ...fullPayload, errorPage: serializedErrorPage };
    const documentNode = makeDocument(JSON.stringify(withErrorPage));

    expect(readHydrationPayload(documentNode)).toEqual(withErrorPage);
  });

  it("rejects a raw Error that serialized without its non-enumerable fields", () => {
    const documentNode = makeDocument(
      JSON.stringify({
        ...fullPayload,
        errorPage: { error: new Error("boom"), status: 500 },
      }),
    );

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it.each([
    ["a missing error", { status: 500 }],
    ["a missing status", { error: serializedErrorPage.error }],
    ["a non-object error", { error: "boom", status: 500 }],
    ["a missing error name", { error: { message: "boom" }, status: 500 }],
    ["a missing error message", { error: { name: "Error" }, status: 500 }],
    [
      "a non-string stack",
      { error: { name: "Error", message: "boom", stack: [] }, status: 500 },
    ],
    [
      "an extra serialized error field",
      { error: { name: "Error", message: "boom", cause: "raw" }, status: 500 },
    ],
    ["a non-5xx status", { error: serializedErrorPage.error, status: 404 }],
    ["a non-integer status", { error: serializedErrorPage.error, status: 500.5 }],
  ])("rejects errorPage with %s", (_caseName, errorPage) => {
    const documentNode = makeDocument(JSON.stringify({ ...fullPayload, errorPage }));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the malformed message when params is present but is not an object", () => {
    const documentNode = makeDocument(JSON.stringify({ ...fullPayload, params: "id=42" }));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  /** `typeof [] === "object"`, so the array case needs its own rejection. */
  it("throws the malformed message when params is an array", () => {
    const documentNode = makeDocument(JSON.stringify({ ...fullPayload, params: ["42"] }));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the malformed message when metadata is present but is not an object", () => {
    const documentNode = makeDocument(JSON.stringify({ ...fullPayload, metadata: "Contact us" }));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });
});

/**
 * The PRODUCER of the same contract, asserted in the same file as the gate that
 * reads it — one payload shape, one place it is proven. A key added to one and
 * not the other is the drift `build-hydration-payload.ts`'s own header exists to
 * prevent, and it is invisible in a suite that tests them apart.
 */
describe("buildHydrationPayload", () => {
  function bundleOf(overrides: Partial<PageDataBundle> = {}): PageDataBundle {
    return {
      route: { name: "users.details", path: "/users/:id", params: { id: "42" }, query: {} },
      appData: { a: 1 },
      layoutData: { l: 1 },
      pageData: { p: 1 },
      shared: { s: 1 } as PageDataBundle["shared"],
      ...overrides,
    };
  }

  it("carries the matched route's params untransformed", () => {
    expect(buildHydrationPayload(bundleOf()).params).toEqual({ id: "42" });
  });

  it("carries an empty params object for a route with no dynamic segments", () => {
    const bundle = bundleOf({
      route: { name: "main.home", path: "/", params: {}, query: {} },
    });

    expect(buildHydrationPayload(bundle).params).toEqual({});
  });

  it("carries the resolved page metadata whole, not a narrowed projection", () => {
    const metadata = {
      title: "Contact us",
      description: "How to reach us",
      keywords: ["contact", "support"],
      canonical: "https://app.test/contact-us",
      robots: "index,follow",
      openGraph: { image: "https://app.test/og.png" },
      twitter: { card: "summary" },
    };

    expect(buildHydrationPayload(bundleOf({ metadata })).metadata).toEqual(metadata);
  });

  /**
   * Not `metadata: undefined` — ABSENT. `JSON.stringify` drops an undefined
   * value, so a key that is present in the in-process object and gone from the
   * parsed one is two different payload shapes wearing one type.
   */
  it("omits the metadata key entirely when the page produced none", () => {
    const payload = buildHydrationPayload(bundleOf());

    expect("metadata" in payload).toBe(false);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("still emits the five gated keys", () => {
    const payload = buildHydrationPayload(bundleOf());

    expect(payload).toMatchObject({
      appData: { a: 1 },
      layoutData: { l: 1 },
      pageData: { p: 1 },
      shared: { s: 1 },
      name: "users.details",
    });
  });
});
