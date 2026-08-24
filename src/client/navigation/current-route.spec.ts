import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";

/**
 * `currentRoute()` / `previousRoute()` — and specifically the claim that makes
 * them different from MRR's: they answer off the SERVER's match.
 *
 * The case worth the most here is the FIRST one below. Before any client
 * navigation there is no swap to have recorded anything, and the server's match
 * is the only match that exists — so a `currentRoute()` that only becomes
 * correct after the first navigation is a `currentRoute()` that is wrong on
 * every landing, which is most page views.
 *
 * The module holds process-wide state on purpose (one document, one current
 * route), so each test takes a FRESH module graph rather than a reset hook:
 * `navigation-root` and `current-route` must be re-imported together or the
 * component would keep writing into the previous test's module instance.
 *
 * The suite runs in vitest's `node` environment (vitest.config.ts): there is no
 * `window` and no DOM unless a test makes one. That is what lets the
 * non-browser cases below be the default state rather than a simulation, and it
 * is why the mount case renders to static markup instead of mounting.
 */

type Modules = {
  currentRoute: typeof import("./current-route").currentRoute;
  previousRoute: typeof import("./current-route").previousRoute;
  recordCurrentRoute: typeof import("./current-route").recordCurrentRoute;
  NavigationRoot: typeof import("./navigation-root").NavigationRoot;
};

async function freshModules(): Promise<Modules> {
  vi.resetModules();

  const { currentRoute, previousRoute, recordCurrentRoute } = await import("./current-route");
  const { NavigationRoot } = await import("./navigation-root");

  return { currentRoute, previousRoute, recordCurrentRoute, NavigationRoot };
}

function payloadOf(name: string): HydrationDocumentPayloadSource {
  return { appData: {}, layoutData: {}, pageData: {}, shared: {}, name };
}

/** Never reached: the mount cases render the initial tree, which is given. */
const buildTree = async (): Promise<ReactNode> => null;

/**
 * Render `NavigationRoot` the way hydration does — with the payload the
 * document was rendered from — and report what the page tree saw while IT was
 * rendering, which is the moment a page component would call `currentRoute()`.
 */
function renderInitialMount(
  modules: Modules,
  payload: HydrationDocumentPayloadSource,
  probe: () => ReactNode,
): string {
  return renderToStaticMarkup(
    createElement(modules.NavigationRoot, {
      pages: [],
      initialPayload: payload,
      initialTree: createElement(probe),
      buildTree,
    }),
  );
}

let modules: Modules;

beforeEach(async () => {
  modules = await freshModules();
});

describe("currentRoute", () => {
  /**
   * THE case. No navigation has happened, nothing has been fetched, and the
   * page tree is mid-render — and the answer is already the entry the server
   * matched, because the hydration payload carried its name.
   */
  it("is the server's matched entry while the initial tree is still rendering", () => {
    const seen: (string | undefined)[] = [];

    const markup = renderInitialMount(modules, payloadOf("products.details"), () => {
      seen.push(modules.currentRoute()?.name);

      return createElement("span", null, modules.currentRoute()?.name ?? "none");
    });

    expect(seen).toEqual(["products.details"]);
    expect(markup).toContain("products.details");
  });

  it("is the server's matched entry after the initial mount too", () => {
    renderInitialMount(modules, payloadOf("main.home"), () => null);

    expect(modules.currentRoute()).toEqual({ name: "main.home" });
  });

  /** Callable from a universal module during the server render. */
  it("returns undefined without throwing when nothing has been rendered", () => {
    expect(() => modules.currentRoute()).not.toThrow();
    expect(modules.currentRoute()).toBeUndefined();
  });

  it("is the newly swapped entry once a navigation records one", () => {
    modules.recordCurrentRoute(payloadOf("main.home"));
    modules.recordCurrentRoute(payloadOf("products.details"));

    expect(modules.currentRoute()).toEqual({ name: "products.details" });
  });
});

describe("previousRoute", () => {
  /** `undefined`, not a throw and not a copy of the current entry. */
  it("is undefined before any navigation has happened", () => {
    renderInitialMount(modules, payloadOf("main.home"), () => null);

    expect(modules.previousRoute()).toBeUndefined();
  });

  it("returns undefined without throwing when nothing has been rendered", () => {
    expect(() => modules.previousRoute()).not.toThrow();
    expect(modules.previousRoute()).toBeUndefined();
  });

  it("is the entry that was swapped out", () => {
    modules.recordCurrentRoute(payloadOf("main.home"));
    modules.recordCurrentRoute(payloadOf("products.details"));

    expect(modules.previousRoute()).toEqual({ name: "main.home" });
  });

  /**
   * A re-render is not a navigation. `NavigationRoot` records on every render
   * pass — that is what makes the mount case above work — so recording is keyed
   * on the payload's IDENTITY: one swap, one payload object, however many times
   * React renders it (StrictMode's double invoke, a parent re-render, a
   * `setState` elsewhere). Without this, simply rendering twice would report
   * the page you are on as the page you came from.
   */
  it("does not shift when the same payload is recorded again", () => {
    const payload = payloadOf("main.home");

    modules.recordCurrentRoute(payload);
    modules.recordCurrentRoute(payload);
    modules.recordCurrentRoute(payload);

    expect(modules.previousRoute()).toBeUndefined();
    expect(modules.currentRoute()).toEqual({ name: "main.home" });
  });

  /**
   * Two payload objects that matched the SAME entry are still two navigations
   * — `/users/1` to `/users/2` is a navigation. It is the identity that is
   * compared, never the name.
   */
  it("reports the same entry when a navigation stays within one route", () => {
    modules.recordCurrentRoute(payloadOf("users.details"));
    modules.recordCurrentRoute(payloadOf("users.details"));

    expect(modules.previousRoute()).toEqual({ name: "users.details" });
  });
});
