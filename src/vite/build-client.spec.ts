import path from "node:path";
import { describe, expect, it } from "vitest";
import { VENDOR_REACT_CHUNK_NAME, warlockHydrationManualChunks } from "./build-client";

/**
 * Card 53f8647e — `warlockHydrationManualChunks` is the whole vendor-split
 * decision: everything about WHICH module lands in `vendor-react` lives in
 * this one pure function, so it is tested directly rather than only through
 * a real Vite build (`index.spec.ts` still runs one real build to prove the
 * wiring, below).
 *
 * RED CONTROL: a naive `id.includes("react")` implementation passes the
 * first case here but also (wrongly) chunks an app module merely named
 * `.../my-reactive-store.ts` — the "an unrelated module whose id merely
 * CONTAINS the substring 'react' is untouched" case below is the one a
 * substring-only implementation fails.
 */
describe("warlockHydrationManualChunks", () => {
  const nodeModulesId = (...segments: string[]) => path.join("/repo", "node_modules", ...segments);

  it("chunks react into vendor-react", () => {
    expect(warlockHydrationManualChunks(nodeModulesId("react", "index.js"))).toBe(
      VENDOR_REACT_CHUNK_NAME,
    );
  });

  it("chunks react-dom into vendor-react", () => {
    expect(warlockHydrationManualChunks(nodeModulesId("react-dom", "client.js"))).toBe(
      VENDOR_REACT_CHUNK_NAME,
    );
  });

  it("chunks scheduler into vendor-react", () => {
    expect(warlockHydrationManualChunks(nodeModulesId("scheduler", "index.js"))).toBe(
      VENDOR_REACT_CHUNK_NAME,
    );
  });

  it("chunks react/jsx-runtime into vendor-react (resolves under node_modules/react/)", () => {
    expect(warlockHydrationManualChunks(nodeModulesId("react", "jsx-runtime.js"))).toBe(
      VENDOR_REACT_CHUNK_NAME,
    );
  });

  it("chunks react/jsx-dev-runtime into vendor-react", () => {
    expect(warlockHydrationManualChunks(nodeModulesId("react", "jsx-dev-runtime.js"))).toBe(
      VENDOR_REACT_CHUNK_NAME,
    );
  });

  it("chunks a hoisted/nested pnpm install layout into vendor-react too", () => {
    expect(
      warlockHydrationManualChunks(
        nodeModulesId(".pnpm", "react@18.3.1", "node_modules", "react", "index.js"),
      ),
    ).toBe(VENDOR_REACT_CHUNK_NAME);
  });

  it("leaves the Warlock client runtime unchunked (stays inside the entry)", () => {
    expect(
      warlockHydrationManualChunks(
        path.join("/repo", "node_modules", "@warlock.js", "web", "esm", "entry", "index.mjs"),
      ),
    ).toBeUndefined();
  });

  it("leaves an app page module unchunked (per-page splitting stays default)", () => {
    expect(
      warlockHydrationManualChunks(path.join("/repo", "src", "web", "blog", "index.page.tsx")),
    ).toBeUndefined();
  });

  it("leaves an unrelated module whose id merely contains the substring 'react' untouched", () => {
    expect(
      warlockHydrationManualChunks(path.join("/repo", "src", "web", "my-reactive-store.ts")),
    ).toBeUndefined();
  });

  it("leaves an unrelated dependency unchunked", () => {
    expect(warlockHydrationManualChunks(nodeModulesId("devalue", "index.js"))).toBeUndefined();
  });
});
