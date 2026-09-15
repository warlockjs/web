// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "./localization";
import { useTextDirection } from "./use-text-direction";

function Probe() {
  const direction = useTextDirection();

  return createElement("span", { "data-direction": direction });
}

function render(locale: string): string {
  return renderToString(createElement(LocaleProvider, { locale, children: createElement(Probe) }));
}

describe("useTextDirection", () => {
  it("resolves rtl for the current locale on the server-render path", () => {
    expect(render("ar")).toContain('data-direction="rtl"');
  });

  it("resolves ltr for the current locale on the server-render path", () => {
    expect(render("en")).toContain('data-direction="ltr"');
  });

  it("resolves rtl for the current locale on the client (hydrated) path", async () => {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);

    let root: ReturnType<typeof createRoot> | undefined;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(
          createElement(LocaleProvider, { locale: "ar", children: createElement(Probe) }),
        );
      });

      expect(container.querySelector("[data-direction]")?.getAttribute("data-direction")).toBe(
        "rtl",
      );
      root?.unmount();
    } finally {
      container.remove();
    }
  });
});
