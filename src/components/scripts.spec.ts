import { createElement } from "react";
import { parse } from "devalue";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentContext, PAYLOAD_SCRIPT_ID, type DocumentContextValue } from "./document-context";
import { markNonHydrating } from "../server/page-render-bundle";
import { Scripts } from "./scripts";

/** Pulls the devalue-serialized payload back out of the rendered `<script>` tag. */
function readPayloadFromHtml(html: string): unknown {
  const match = /<script id="__WARLOCK_DATA__"[^>]*>(.*?)<\/script>/.exec(html);

  if (match === null) throw new Error("payload script not found in rendered HTML");

  return parse(match[1]!);
}

function documentValue(overrides: Partial<DocumentContextValue> = {}): DocumentContextValue {
  return {
    metadata: undefined,
    payload: {
      appData: {},
      layoutData: {},
      pageData: {},
      shared: {},
      name: "account",
      locale: "en",
      translations: {},
    },
    ...overrides,
  };
}

function render(value: DocumentContextValue): string {
  return renderToString(
    createElement(DocumentContext.Provider, { value, children: createElement(Scripts, {}) }),
  );
}

describe("Scripts", () => {
  it("emits the __WARLOCK_DATA__ payload for an ordinary document (including a normal app error page)", () => {
    const html = render(documentValue());

    expect(html).toContain(PAYLOAD_SCRIPT_ID);
    expect(readPayloadFromHtml(html)).toMatchObject({ name: "account" });
  });

  it("omits the __WARLOCK_DATA__ payload when the payload is marked non-hydrating (renderPageFailure's pre-triple fallback)", () => {
    const html = render(documentValue({ payload: markNonHydrating(documentValue().payload) }));

    expect(html).toBe("");
    expect(html).not.toContain(PAYLOAD_SCRIPT_ID);
  });

  it("carries the request's CSP nonce on the payload script, from the document-context slot", () => {
    const html = render(documentValue({ nonce: "ctx-nonce-1" }));

    expect(html).toContain('nonce="ctx-nonce-1"');
  });

  it("omits the nonce attribute entirely when the request has none", () => {
    const html = render(documentValue({ nonce: undefined }));

    expect(html).not.toContain("nonce=");
  });

  it("renders the hydration client entry module after the payload script, carrying the same nonce", () => {
    const html = render(
      documentValue({ nonce: "ctx-nonce-1", hydrationClientModuleUrl: "/hydrate.js" }),
    );

    expect(html).toContain('<script type="module" nonce="ctx-nonce-1" src="/hydrate.js">');
    expect(html.indexOf(PAYLOAD_SCRIPT_ID)).toBeLessThan(html.indexOf("/hydrate.js"));
  });

  it("omits the hydration client entry module when no URL is configured", () => {
    const html = render(documentValue());

    expect(html).not.toContain('type="module"');
  });

  it("omits the hydration client entry module on a non-hydrating document, even with a URL configured", () => {
    const html = render(
      documentValue({
        payload: markNonHydrating(documentValue().payload),
        hydrationClientModuleUrl: "/hydrate.js",
      }),
    );

    expect(html).toBe("");
  });
});
