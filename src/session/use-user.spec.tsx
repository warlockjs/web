import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/navigation/fetch-page-data", () => ({
  fetchPageData: vi.fn(async () => ({ type: "payload", payload: {} })),
}));

import {
  prefetchPageData,
  resetPrefetchCache,
  takePrefetchedPageData,
} from "../client/navigation/prefetch";
import { installSession, resetSession, SessionContext, useUser } from "./use-user";

afterEach(() => {
  resetSession();
  resetPrefetchCache();
  vi.unstubAllGlobals();
});

function Probe() {
  const user = useUser();

  return createElement("span", null, user === null ? "guest" : String((user as { id: unknown }).id));
}

describe("useUser / installSession", () => {
  it("reads null, then the user after installSession", () => {
    expect(renderToString(createElement(Probe))).toContain("guest");

    installSession({ user: { id: 7 } });

    expect(renderToString(createElement(Probe))).toContain("7");
  });

  it("treats a missing session key as a guest", () => {
    installSession({ user: { id: 1 } });
    installSession(undefined);

    expect(renderToString(createElement(Probe))).toContain("guest");
  });

  it("prefers a server-render provider", () => {
    const tree = createElement(
      SessionContext.Provider,
      { value: { user: { id: 9 } } },
      createElement(Probe),
    );

    expect(renderToString(tree)).toContain("9");
  });

  it("refuses a guest-tagged prefetch after login", async () => {
    vi.stubGlobal("window", {});

    await prefetchPageData("/account");
    installSession({ user: { id: 1 } });

    expect(takePrefetchedPageData("/account")).toBeUndefined();
  });

  it("serves a prefetch when the identity is unchanged", async () => {
    vi.stubGlobal("window", {});
    installSession({ user: { id: 1 } });

    await prefetchPageData("/a");
    installSession({ user: { id: 1 } });

    expect(takePrefetchedPageData("/a")).toBeDefined();
  });

  it("clears the prefetch cache on identity change", async () => {
    vi.stubGlobal("window", {});
    await prefetchPageData("/b");
    installSession({ user: { id: 2 } });
    installSession(undefined);
    await prefetchPageData("/c");
    installSession({ user: { id: 2 } });

    expect(takePrefetchedPageData("/b")).toBeUndefined();
    expect(takePrefetchedPageData("/c")).toBeUndefined();
  });
});
