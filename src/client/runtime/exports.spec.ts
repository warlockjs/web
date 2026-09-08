import { describe, expect, it } from "vitest";

describe("client package export", () => {
  it("resolves the public client subpath", async () => {
    const runtime = await import("@warlock.js/web/client/runtime");

    expect(typeof runtime.validateClientRouteManifest).toBe("function");
    expect(typeof runtime.loadClientRouteComposition).toBe("function");
  });
});
