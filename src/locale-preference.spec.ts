import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCALE_PREFERENCE_COOKIE_NAME } from "./locale-preference";

describe("locale preference cookie contract", () => {
  it("matches core's private reader constant without importing core into browser code", () => {
    const source = readFileSync(
      new URL("../../core/src/config/locale-configuration.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      `LOCALE_PREFERENCE_COOKIE_NAME = \"${LOCALE_PREFERENCE_COOKIE_NAME}\"`,
    );
  });
});
