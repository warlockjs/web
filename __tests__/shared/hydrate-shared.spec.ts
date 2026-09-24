import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sharedModule from "../../src/shared";
import { hydrateShared, useShared } from "../../src/shared";

/**
 * Separate file on purpose (see shared-unconnected.spec.ts's header): vitest
 * isolates module state per file, so stubbing `window` here cannot bleed the
 * ALS-backed specs in shared-proxy.spec.ts into a false "browser" branch.
 */
describe("hydrateShared — browser snapshot install", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("installs a snapshot that useShared() reads back in a browser context", () => {
    hydrateShared({ locale: "en", user: { name: "hasan" } });

    vi.stubGlobal("window", {});

    const view = readSharedInComponent();

    expect(view.locale).toBe("en");
    expect(view.user).toEqual({ name: "hasan" });
  });

  it("does not export the withdrawn installBrowserSharedSnapshot name", () => {
    expect("installBrowserSharedSnapshot" in sharedModule).toBe(false);
    expect(Object.getOwnPropertyNames(sharedModule)).not.toContain("installBrowserSharedSnapshot");
  });
});

/** `useShared()` is a hook (W3:B15), so it must run inside a component render. */
function readSharedInComponent(): Record<string, any> {
  let view: Record<string, any> | undefined;

  function Probe() {
    view = useShared() as Record<string, any>;
    return null;
  }

  renderToString(createElement(Probe));

  return view!;
}
