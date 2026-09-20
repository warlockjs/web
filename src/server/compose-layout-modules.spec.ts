import { describe, expect, it } from "vitest";
import { composeLayoutModules } from "./compose-layout-modules";
import type { LayoutModuleShape } from "./page-module-shapes";

describe("composeLayoutModules", () => {
  it("spreads the host layout's own namespace", () => {
    const outer: LayoutModuleShape = { prefix: "/shop" };
    const host: LayoutModuleShape = { prefix: "/profile", default: function Inner() {} };

    const composed = composeLayoutModules([outer, host], 1);

    expect(composed.prefix).toBe("/profile");
    expect(composed.default).toBe(host.default);
  });

  it("flattens every layout's middleware, OUTERMOST FIRST", async () => {
    const order: string[] = [];
    const outerGuard = () => {
      order.push("outer");
    };
    const middleGuard = () => {
      order.push("middle");
    };
    const innerGuard = () => {
      order.push("inner");
    };

    const outer: LayoutModuleShape = { middleware: [outerGuard] };
    const middle: LayoutModuleShape = { middleware: [middleGuard] };
    const inner: LayoutModuleShape = { middleware: [innerGuard], default: function Inner() {} };

    const composed = composeLayoutModules([outer, middle, inner], 2);

    expect(composed.middleware).toEqual([outerGuard, middleGuard, innerGuard]);

    for (const middleware of composed.middleware ?? []) {
      await middleware({} as never);
    }

    expect(order).toEqual(["outer", "middle", "inner"]);
  });

  it("treats a layout with no middleware export as contributing none", () => {
    const outer: LayoutModuleShape = {};
    const host: LayoutModuleShape = { default: function Inner() {} };

    const composed = composeLayoutModules([outer, host], 1);

    expect(composed.middleware).toEqual([]);
  });

  it("folds the loaders through foldLayoutLoaders, keyed to the HOST index", async () => {
    const outerLoader = () => "outer-data";
    const hostLoader = () => "host-data";

    const outer: LayoutModuleShape = { loader: outerLoader };
    const host: LayoutModuleShape = { loader: hostLoader, default: function Inner() {} };

    const composed = composeLayoutModules([outer, host], 1);

    await expect(composed.loader?.({} as never)).resolves.toBe("host-data");
  });

  it("adds the nearest defined static robots directive from the full layout chain", () => {
    const composed = composeLayoutModules(
      [
        { metadata: { robots: "index,follow" } },
        { middleware: [], metadata: { robots: "noindex" } },
        { default: function Host() {} },
      ],
      2,
      ["src/web/layout.tsx", "src/web/admin/layout.tsx", "src/web/admin/users/layout.tsx"],
    );

    expect(composed.metadata).toEqual({ robots: "noindex" });
  });
});
