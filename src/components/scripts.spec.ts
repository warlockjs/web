import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentContext, PAYLOAD_SCRIPT_ID, type DocumentContextValue } from "./document-context";
import { markNonHydrating } from "../server/page-render-bundle";
import { Scripts } from "./scripts";

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
    expect(html).toContain('"name":"account"');
  });

  it("omits the __WARLOCK_DATA__ payload when the payload is marked non-hydrating (renderPageFailure's pre-triple fallback)", () => {
    const html = render(documentValue({ payload: markNonHydrating(documentValue().payload) }));

    expect(html).toBe("");
    expect(html).not.toContain(PAYLOAD_SCRIPT_ID);
  });
});
