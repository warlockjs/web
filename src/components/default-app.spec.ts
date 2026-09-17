import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentContext, HYDRATION_ROOT_ID, type DocumentContextValue } from "./document-context";
import DefaultApp from "./default-app";

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

function render(children: string): string {
  return renderToStaticMarkup(
    createElement(DocumentContext.Provider, {
      value: documentValue(),
      children: createElement(DefaultApp, { children }),
    }),
  );
}

describe("DefaultApp", () => {
  it("renders the hydration mount point as #vessel, not #root", () => {
    const html = render("page content");

    expect(html).toContain(`id="${HYDRATION_ROOT_ID}"`);
    expect(html).toContain('id="vessel"');
    expect(html).not.toContain('id="root"');
  });

  it("wraps the children inside the #vessel mount element", () => {
    const html = render("page content");

    expect(html).toContain('id="vessel">page content</div>');
  });
});
