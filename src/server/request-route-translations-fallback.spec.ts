import { groupedTranslations, setTranslationsList, trans } from "@mongez/localization";
import { afterEach, describe, expect, it } from "vitest";
import { bindRequestRouteTranslations } from "./request-route-translations";
import type { RouteTranslationsResolver } from "./route-translations";

// FORMAI #14: core `t()` is `request.trans(k) || trans(k)`. These pin how the
// snapshot-vs-registry fallback behaves for keys registered with groupedTranslations.
const bind = (keywords: Record<string, unknown>, locale = "en") => {
  const resolver: RouteTranslationsResolver = (_s, l) => ({
    locale: l,
    keywords: keywords as any,
    revision: "r",
  });
  const request: any = { locale };
  bindRequestRouteTranslations(request, resolver, "page");
  return request;
};
const coreT = (request: any, key: string) => request.trans(key) || trans(key);

describe("route translation snapshot fallback (FORMAI #14)", () => {
  afterEach(() => setTranslationsList({}));

  it("falls back to the global registry when the snapshot lacks the key", () => {
    groupedTranslations("programs", { title: { en: "Programs", ar: "البرامج" } });
    expect(bind({ other: "x" }).t("programs.title")).toBe("Programs");
  });

  it("falls back when the snapshot has the group but not the key", () => {
    groupedTranslations("programs", { title: { en: "Programs" } });
    expect(bind({ programs: { unrelated: "u" } }).t("programs.title")).toBe("Programs");
  });

  it("H1: snapshot with an empty value wins over the registry; core t() then uses trans()", () => {
    groupedTranslations("programs", { title: { en: "Programs" } });
    const request = bind({ programs: { title: "" } });
    expect(request.t("programs.title")).toBe(""); // hasKeyword true, empty preserved
    expect(coreT(request, "programs.title")).toBe("Programs"); // rescued by `||` only if registry is the same instance
  });

  it("H1: a snapshot key holding a locale-shaped object (unflattened group) is returned as an object, not a string", () => {
    const request = bind({ programs: { title: { en: "Programs", ar: "x" } } });
    expect(typeof request.t("programs.title")).toBe("object");
  });

  it("H4 ruled out: unregistered locale still resolves through the fallback locale", () => {
    groupedTranslations("programs", { title: { en: "Programs" } });
    expect(bind({}, "fr").t("programs.title")).toBe("Programs");
  });

  it("registry that core never wrote to (second instance) yields the raw key", () => {
    // simulates H2/H3: nothing registered in THIS module instance
    expect(bind({}).t("programs.title")).toBe("programs.title");
  });
});
