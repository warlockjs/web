import { describe, expect, it } from "vitest";
import { buildHydrationPayload } from "./build-hydration-payload";
import type { PageDataBundle } from "./execute-page-request";

function bundleOf(): PageDataBundle {
  return {
    route: { name: "home", path: "/", params: {}, query: {} },
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {} as PageDataBundle["shared"],
  };
}

describe("session payload key", () => {
  it("omits the key when web.session is not configured", () => {
    expect("session" in buildHydrationPayload(bundleOf(), "en")).toBe(false);
  });

  it("carries a guest as { user: null }", () => {
    const payload = buildHydrationPayload(bundleOf(), "en", { session: { user: null } });

    expect(payload.session).toEqual({ user: null });
  });

  it("carries the projection only, never raw model fields", () => {
    const projection = { id: 7, name: "Ada" };
    const payload = buildHydrationPayload(bundleOf(), "en", { session: { user: projection } });

    expect(JSON.stringify(payload.session)).not.toContain("password");
    expect(payload.session).toEqual({ user: projection });
  });
});

describe("session payload key on the data (JSON/NDJSON) path", () => {
  it("reads the projection off the bundle when no extras are passed", () => {
    const bundle = { ...bundleOf(), session: { user: { id: 3 } } };

    expect(buildHydrationPayload(bundle, "en").session).toEqual({ user: { id: 3 } });
  });

  it("carries a guest bundle as { user: null }", () => {
    const bundle = { ...bundleOf(), session: { user: null } };

    expect(buildHydrationPayload(bundle, "en").session).toEqual({ user: null });
  });
});
