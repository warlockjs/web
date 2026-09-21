import { getKeywordsListOf, setTranslationsList } from "@mongez/localization";
import { afterEach, describe, expect, it } from "vitest";
import type { HydrationDocumentPayloadSource } from "../hydration-payload";
import {
  installPayloadTranslations,
  scopedPayloadTranslations,
} from "./install-payload-translations";

function payload(mode?: "scoped"): HydrationDocumentPayloadSource {
  return {
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {},
    name: "home",
    locale: "snapshot-test",
    translations: { account: { title: "Snapshot" } },
    ...(mode === undefined ? {} : { translationMode: mode }),
  };
}

afterEach(() => setTranslationsList({}));

describe("payload translations", () => {
  it("does not register a scoped JSON snapshot globally", () => {
    const source = payload("scoped");

    installPayloadTranslations(source);

    expect(getKeywordsListOf(source.locale)).toBeNull();
  });

  it("copies and freezes a scoped snapshot once per payload", () => {
    const source = payload("scoped");
    const first = scopedPayloadTranslations(source);
    const second = scopedPayloadTranslations(source);

    expect(first).toBe(second);
    expect(first).toEqual({ account: { title: "Snapshot" } });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.account)).toBe(true);

    source.translations.account = { title: "Changed source" };
    expect(first).toEqual({ account: { title: "Snapshot" } });
  });

  it("keeps legacy payload registration unchanged", () => {
    const source = payload();

    installPayloadTranslations(source);

    expect(getKeywordsListOf(source.locale)).toEqual(source.translations);
  });
});
