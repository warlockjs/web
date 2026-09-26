import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageManifest } from "./page-manifest";
import type { SiteDispatchInstall } from "./site-dispatch";

const installPageRoutesFromManifest = vi.fn((_options: unknown) => []);

vi.mock("./index", () => ({
  connectSharedStore: vi.fn(),
  connectPageContext: vi.fn(),
  installPageRoutesFromManifest,
}));

afterEach(() => {
  installPageRoutesFromManifest.mockClear();
});

describe("installProductionPageRoutes", () => {
  it("forwards the multi-site dispatcher, so production installs per site", async () => {
    const { installProductionPageRoutes } = await import("./install-production-page-routes");
    const siteDispatch = { sites: {}, dispatch: {} } as unknown as SiteDispatchInstall;

    await installProductionPageRoutes({
      router: {} as never,
      manifest: { pages: [{}] } as unknown as PageManifest,
      pageContext: {} as never,
      sharedStore: () => undefined as never,
      resolveHydrationClientModuleUrl: () => "/assets/hydration-landing.js",
      siteDispatch,
    });

    expect(installPageRoutesFromManifest).toHaveBeenCalledWith(
      expect.objectContaining({ siteDispatch }),
    );
  });
});
