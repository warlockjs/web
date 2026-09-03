import { setTranslationsList } from "@mongez/localization";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocaleProvider, useLocale, useTrans } from "./localization";

function Probe() {
  const locale = useLocale();
  const trans = useTrans();

  return createElement("span", { "data-locale": locale }, String(trans("greeting")));
}

function ConvertedProbe() {
  const trans = useTrans();

  return createElement(
    "div",
    null,
    trans("greeting", {}, (translation) =>
      createElement("strong", null, translation),
    ),
  );
}

function render(locale: string): string {
  return renderToString(
    createElement(LocaleProvider, { locale, children: createElement(Probe) }),
  );
}

describe("request-bound localization", () => {
  beforeEach(() => {
    setTranslationsList({
      en: { greeting: "Hello" },
      ar: { greeting: "مرحبا" },
    });
  });

  afterEach(() => setTranslationsList({}));

  it("fails closed outside the framework provider", () => {
    expect(() => renderToString(createElement(Probe))).toThrow(/outside Warlock's LocaleProvider/);
  });

  it("keeps simultaneous render roots isolated without changing the global locale", async () => {
    const [english, arabic] = await Promise.all([
      Promise.resolve().then(() => render("en")),
      Promise.resolve().then(() => render("ar")),
    ]);

    expect(english).toContain('data-locale="en"');
    expect(english).toContain("Hello");
    expect(arabic).toContain('data-locale="ar"');
    expect(arabic).toContain("مرحبا");
  });

  it("accepts an explicit React converter without changing locale resolution", () => {
    const html = renderToString(
      createElement(LocaleProvider, {
        locale: "ar",
        children: createElement(ConvertedProbe),
      }),
    );

    expect(html).toContain("<strong>مرحبا</strong>");
  });
});
