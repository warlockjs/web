import { stringify } from "devalue";
import { describe, expect, it } from "vitest";
import { escapePayload, PAYLOAD_SCRIPT_ID } from "./components/document-context";
import {
  isHydrationPayload,
  REQUIRED_PAYLOAD_KEYS,
  readHydrationPayload,
} from "./hydration-payload";
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
  locale: "en",
  translations: {},
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
  it("parses and returns a payload object with all six keys", () => {
    const documentNode = makeDocument(stringify(fullPayload));

    expect(readHydrationPayload(documentNode)).toEqual(fullPayload);
  });

  /**
   * Asserted against the CONTRACT export itself, not a copy of it — a key
   * added to or removed from `REQUIRED_PAYLOAD_KEYS` without this fixture
   * changing to match fails right here, before it fails silently on the wire.
   */
  it("fullPayload's keys are exactly REQUIRED_PAYLOAD_KEYS", () => {
    expect(Object.keys(fullPayload).sort()).toEqual([...REQUIRED_PAYLOAD_KEYS].sort());
  });

  it.each(REQUIRED_PAYLOAD_KEYS)(
    "throws the malformed message when the required key %s is missing",
    (key) => {
      const withoutKey = { ...fullPayload };
      delete (withoutKey as Record<string, unknown>)[key];

      const documentNode = makeDocument(stringify(withoutKey));

      expect(() => readHydrationPayload(documentNode)).toThrow(
        /Warlock hydration payload was found at #.* but could not be read\./,
      );
    },
  );

  it("throws the malformed message when name is missing", () => {
    const { name, ...withoutName } = fullPayload;

    const documentNode = makeDocument(stringify(withoutName));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it.each([undefined, "", 42])("rejects an absent or invalid request locale (%s)", (locale) => {
    const payload = { ...fullPayload, locale };

    if (locale === undefined) delete (payload as { locale?: unknown }).locale;

    expect(() => readHydrationPayload(makeDocument(stringify(payload)))).toThrow(
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

    const documentNode = makeDocument(stringify(withoutShared));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  /**
   * `metadata`, `params` and `errorPage` are OPTIONAL: absent is a valid
   * payload, wrong-typed is not.
   *
   * They are ungated on purpose. The six gated keys are the ones the browser
   * cannot build a page without — no `name`, no page to look up; no `shared`,
   * no state to hydrate — so their absence has to be a loud failure. A page
   * that exports no `metadata` produces none (`bundle.metadata` is optional at
   * `server/execute-page-request.ts:296`), so requiring the key would make the
   * gate throw on a payload the server is right to have produced.
   */
  it("accepts an ordinary payload without metadata, params or errorPage", () => {
    const documentNode = makeDocument(stringify(fullPayload));

    expect(() => readHydrationPayload(documentNode)).not.toThrow();
  });

  it("accepts only the scoped translation-mode discriminator", () => {
    const scoped = { ...fullPayload, translationMode: "scoped" };

    expect(readHydrationPayload(makeDocument(stringify(scoped)))).toEqual(scoped);
    expect(() =>
      readHydrationPayload(makeDocument(stringify({ ...fullPayload, translationMode: "global" }))),
    ).toThrow(/Warlock hydration payload was found at #.* but could not be read\./);
  });

  it.each([
    ["a null leaf", { nested: null }],
    ["a numeric leaf", { nested: 1 }],
    ["an array leaf", { nested: ["value"] }],
    ["a __proto__ key", JSON.parse('{"__proto__":"value"}')],
    ["a prototype key", { prototype: "value" }],
    ["a constructor key", { constructor: "value" }],
  ])("rejects a scoped payload with %s", (_label, translations) => {
    expect(
      isHydrationPayload({
        ...fullPayload,
        translationMode: "scoped",
        translations,
      }),
    ).toBe(false);
  });

  it("rejects a devalue cycle in scoped translations before provider rendering", () => {
    const translations: Record<string, unknown> = {};
    translations.self = translations;
    const cyclicPayload = { ...fullPayload, translationMode: "scoped", translations };

    expect(() => readHydrationPayload(makeDocument(stringify(cyclicPayload)))).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("returns metadata and params when the payload carries them", () => {
    const withBoth = {
      ...fullPayload,
      metadata: { title: "Contact us" },
      params: { id: "42" },
    };

    const documentNode = makeDocument(stringify(withBoth));

    expect(readHydrationPayload(documentNode)).toEqual(withBoth);
  });

  it("returns a JSON-round-tripped serialized error-page selection", () => {
    const withErrorPage = { ...fullPayload, errorPage: serializedErrorPage };
    const documentNode = makeDocument(stringify(withErrorPage));

    expect(readHydrationPayload(documentNode)).toEqual(withErrorPage);
  });

  /**
   * devalue refuses a raw `Error` outright (`DevalueError: Cannot stringify
   * arbitrary non-POJOs`) — the standing serialization ruling catches this
   * case even earlier than the reader does, at `buildHydrationPayload`'s own
   * validation (`build-hydration-payload.spec.ts`). This spec keeps the
   * READER'S half of the same contract: an `error` value present but missing
   * its required `name`/`message` fields — the shape a lossy serializer would
   * have produced — is still rejected here regardless of what produced it.
   */
  it("rejects an error-page selection whose error is missing its required fields", () => {
    const documentNode = makeDocument(
      stringify({
        ...fullPayload,
        errorPage: { error: {}, status: 500 },
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
    ["a non-string stack", { error: { name: "Error", message: "boom", stack: [] }, status: 500 }],
    [
      "an extra serialized error field",
      { error: { name: "Error", message: "boom", cause: "raw" }, status: 500 },
    ],
    ["a non-5xx status", { error: serializedErrorPage.error, status: 404 }],
    ["a non-integer status", { error: serializedErrorPage.error, status: 500.5 }],
  ])("rejects errorPage with %s", (_caseName, errorPage) => {
    const documentNode = makeDocument(stringify({ ...fullPayload, errorPage }));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the malformed message when params is present but is not an object", () => {
    const documentNode = makeDocument(stringify({ ...fullPayload, params: "id=42" }));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  /** `typeof [] === "object"`, so the array case needs its own rejection. */
  it("throws the malformed message when params is an array", () => {
    const documentNode = makeDocument(stringify({ ...fullPayload, params: ["42"] }));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the malformed message when metadata is present but is not an object", () => {
    const documentNode = makeDocument(stringify({ ...fullPayload, metadata: "Contact us" }));

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
    expect(buildHydrationPayload(bundleOf(), "en").params).toEqual({ id: "42" });
  });

  it("carries an empty params object for a route with no dynamic segments", () => {
    const bundle = bundleOf({
      route: { name: "main.home", path: "/", params: {}, query: {} },
    });

    expect(buildHydrationPayload(bundle, "en").params).toEqual({});
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

    expect(buildHydrationPayload(bundleOf({ metadata }), "en").metadata).toEqual(metadata);
  });

  /**
   * Not `metadata: undefined` — ABSENT. `JSON.stringify` drops an undefined
   * value, so a key that is present in the in-process object and gone from the
   * parsed one is two different payload shapes wearing one type.
   */
  it("omits the metadata key entirely when the page produced none", () => {
    const payload = buildHydrationPayload(bundleOf(), "en");

    expect("metadata" in payload).toBe(false);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("emits the six gated keys, including the request locale", () => {
    const payload = buildHydrationPayload(bundleOf(), "ar");

    expect(payload).toMatchObject({
      appData: { a: 1 },
      layoutData: { l: 1 },
      pageData: { p: 1 },
      shared: { s: 1 },
      name: "users.details",
      locale: "ar",
    });
  });
});

/**
 * devalue is the page-data wire format (standing ruling). This is the
 * DOCUMENT-hydration half of the round-trip guarantee that plain JSON never
 * gave: a `Date`, `Map`, `Set`, `BigInt`, an `undefined` inside an object, a
 * repeated reference to the SAME object, and a cyclic structure all have to
 * survive `stringify` → (the same escaping `scripts.ts` applies) → `parse`
 * with their real identity and type, not a flattened JSON approximation.
 */
describe("document hydration payload — devalue round trip", () => {
  function bundleOf(pageData: unknown): PageDataBundle {
    return {
      route: { name: "round-trip", path: "/round-trip", params: {}, query: {} },
      appData: {},
      layoutData: {},
      pageData,
      shared: {} as PageDataBundle["shared"],
    };
  }

  /** Mirrors `scripts.ts`: devalue `stringify`, then the same HTML escaping, then read back. */
  function roundTrip(pageData: unknown): unknown {
    const payload = buildHydrationPayload(bundleOf(pageData), "en");
    const scriptTextContent = escapePayload(stringify(payload));

    return readHydrationPayload(makeDocument(scriptTextContent)).pageData;
  }

  it("round-trips a Date", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");

    expect(roundTrip({ date })).toEqual({ date });
    expect((roundTrip({ date }) as { date: unknown }).date).toBeInstanceOf(Date);
  });

  it("round-trips a Map", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);

    expect(roundTrip({ map })).toEqual({ map });
  });

  it("round-trips a Set", () => {
    const set = new Set([1, 2, 3]);

    expect(roundTrip({ set })).toEqual({ set });
  });

  it("round-trips a BigInt", () => {
    expect(roundTrip({ big: 42n })).toEqual({ big: 42n });
  });

  it("round-trips undefined inside an object", () => {
    const result = roundTrip({ missing: undefined, present: 1 }) as Record<string, unknown>;

    expect("missing" in result).toBe(true);
    expect(result.missing).toBeUndefined();
    expect(result.present).toBe(1);
  });

  it("round-trips a repeated reference as the SAME object", () => {
    const shared = { id: 1 };
    const result = roundTrip({ first: shared, second: shared }) as {
      first: unknown;
      second: unknown;
    };

    expect(result.first).toBe(result.second);
  });

  it("round-trips a cyclic structure", () => {
    const node: { self?: unknown } = {};
    node.self = node;

    const result = roundTrip({ node }) as { node: { self: unknown } };

    expect(result.node.self).toBe(result.node);
  });
});
