import { describe, expect, it, vi } from "vitest";
import { scrollToFragment, type FragmentScrollDocument } from "./scroll-to-fragment";

/**
 * The lookup rules, proved with no DOM (`web/vitest.config.ts` runs `node`) —
 * which is exactly why `scrollToFragment` takes its document as an argument.
 *
 * The assertion this file exists for is the NEGATIVE one: a fragment that
 * matches nothing must return quietly. It is an ordinary state of the web, and
 * a throw here would cost the page for the sake of a scroll.
 */
function documentWith(elements: Record<string, { scrollIntoView(): void }>) {
  return {
    getElementById: (id: string) => elements[id] ?? null,
  } satisfies FragmentScrollDocument;
}

describe("scrollToFragment", () => {
  it("scrolls to the element whose id matches", () => {
    const scrollIntoView = vi.fn();

    expect(scrollToFragment(documentWith({ install: { scrollIntoView } }), "install")).toBe(
      true,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("decodes the fragment before looking the id up", () => {
    const scrollIntoView = vi.fn();

    expect(
      scrollToFragment(documentWith({ "a b": { scrollIntoView } }), "a%20b"),
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and does not throw, when nothing matches", () => {
    expect(scrollToFragment(documentWith({}), "gone")).toBe(false);
  });

  it("does nothing for an empty fragment — it names no target", () => {
    const getElementById = vi.fn();

    expect(scrollToFragment({ getElementById }, "")).toBe(false);
    expect(getElementById).not.toHaveBeenCalled();
  });

  it("does not throw on a fragment that is not a valid CSS selector", () => {
    // `querySelector("#1")` throws; `getElementById("1")` simply misses.
    expect(scrollToFragment(documentWith({}), "1")).toBe(false);
  });

  it("falls back to a legacy named anchor", () => {
    const scrollIntoView = vi.fn();

    const result = scrollToFragment(
      {
        getElementById: () => null,
        getElementsByName: (name: string) =>
          name === "install" ? [{ scrollIntoView }] : [],
      },
      "install",
    );

    expect(result).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
