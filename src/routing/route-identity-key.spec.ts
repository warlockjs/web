import { describe, expect, it } from "vitest";
import { routeIdentityKey } from "./route-identity-key";

describe("routeIdentityKey", () => {
  it("ignores parameter names", () => {
    expect(routeIdentityKey({ path: "/blog/:id" })).toBe(routeIdentityKey({ path: "/blog/:slug" }));
  });

  it("keeps a single-site key equal to the bare normalised path", () => {
    expect(routeIdentityKey({ path: "/blog/:id" })).toBe("/blog/:_");
  });

  it("keeps optional params distinct from required ones", () => {
    expect(routeIdentityKey({ path: "/blog/:x?" })).toBe(routeIdentityKey({ path: "/blog/:y?" }));
    expect(routeIdentityKey({ path: "/blog/:x?" })).not.toBe(routeIdentityKey({ path: "/blog/:x" }));
  });

  it("keeps wildcards distinct from params and static segments", () => {
    expect(routeIdentityKey({ path: "/files/*" })).not.toBe(routeIdentityKey({ path: "/files/:x" }));
    expect(routeIdentityKey({ path: "/files/:rest*" })).not.toBe(
      routeIdentityKey({ path: "/files/:rest" }),
    );
  });

  it("gives the same path a different key per site and per method", () => {
    const a = routeIdentityKey({ site: "a", path: "/blog/:id" });
    const b = routeIdentityKey({ site: "b", path: "/blog/:id" });

    expect(a).not.toBe(b);
    expect(a).not.toBe(routeIdentityKey({ path: "/blog/:id" }));
    expect(routeIdentityKey({ method: "GET", path: "/x" })).not.toBe(
      routeIdentityKey({ method: "POST", path: "/x" }),
    );
  });
});
