import { afterEach, describe, expect, it, vi } from "vitest";
import { connectNavigator, type Navigator } from "../../routing/navigator";
import { getHash, navigateBack, navigateTo } from "./verbs";

/**
 * The three history verbs, and specifically their behaviour with NOTHING
 * attached.
 *
 * Every one of these is reachable from a module that also renders on the
 * server — an event handler defined at module scope, a helper imported by a
 * universal component. So the contract each test below pins is the same one:
 * with no navigator connected and no `window`, these return the "did nothing"
 * value rather than throwing. A navigation helper that throws during a server
 * render costs the whole page, not the navigation.
 *
 * The suite runs in vitest's `node` environment (vitest.config.ts), so `window`
 * genuinely does not exist unless a test stubs it — the no-window cases are the
 * default state here, not a simulation of one.
 */

/** Restore whatever the module had, so a test never leaks a navigator. */
function withNavigator(navigator: Navigator | undefined): void {
  connectNavigator(navigator);
}

afterEach(() => {
  withNavigator(undefined);
  vi.unstubAllGlobals();
});

describe("navigateTo", () => {
  it("hands the url and options to the connected navigator, and reports what it decided", () => {
    const navigator = vi.fn<Navigator>(() => true);

    withNavigator(navigator);

    expect(navigateTo("/products", { replace: true })).toBe(true);
    expect(navigator).toHaveBeenCalledWith("/products", { replace: true });
  });

  it("passes no options through when the caller gave none", () => {
    const navigator = vi.fn<Navigator>(() => true);

    withNavigator(navigator);

    navigateTo("/products");

    expect(navigator).toHaveBeenCalledWith("/products", undefined);
  });

  /**
   * "Not mine" — the same answer `<Link>` gets. A navigator that declines has
   * decided the browser should handle the URL, and this verb must not upgrade
   * that refusal into a success.
   */
  it("relays a refusal rather than claiming the navigation", () => {
    withNavigator(vi.fn<Navigator>(() => false));

    expect(navigateTo("/products")).toBe(false);
  });

  /**
   * The server render, and the window between first paint and hydration. Both
   * are real call sites and neither has a runtime to delegate to.
   */
  it("returns false without throwing when no navigator is connected", () => {
    expect(() => navigateTo("/products")).not.toThrow();
    expect(navigateTo("/products", { replace: true })).toBe(false);
  });
});

describe("navigateBack", () => {
  it("asks the browser to go back", () => {
    const back = vi.fn();

    vi.stubGlobal("window", { history: { back } });

    navigateBack();

    expect(back).toHaveBeenCalledTimes(1);
  });

  it("does nothing and does not throw with no window", () => {
    expect(() => navigateBack()).not.toThrow();
  });
});

describe("getHash", () => {
  it("returns the hash without its leading marker, as MRR's does", () => {
    vi.stubGlobal("window", { location: { hash: "#reviews" } });

    expect(getHash()).toBe("reviews");
  });

  it("returns an empty string when the url carries no hash", () => {
    vi.stubGlobal("window", { location: { hash: "" } });

    expect(getHash()).toBe("");
  });

  /** `""` and not `undefined`: callers treat the result as a string. */
  it("returns an empty string with no window", () => {
    expect(getHash()).toBe("");
  });
});
