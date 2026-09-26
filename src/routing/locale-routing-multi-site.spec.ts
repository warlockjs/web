import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "@mongez/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestContext as coreRequestContext, type Router } from "@warlock.js/core";
import * as createPageRouteHandlerModule from "../server/create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "../server/create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "../server/install-page-routes";
import { installPageRoutesFromManifest } from "../server/install-page-routes-from-manifest";
import type { PageManifest, PageManifestPageEntry } from "../server/page-manifest";
import { resolveDocumentLocaleRouting } from "../server/resolve-locale-alternates";
import { createSiteDispatch, type SiteDispatchInstall } from "../server/site-dispatch";
import type { SitesConfig } from "../sites/site-config.types";
import { Link } from "../components/link";
import { localizedPath } from "./localized-path";
import { publishLocaleRouting, readLocaleRouting, resetLocaleRouting, type LocaleRouting } from "./locale-routing";
import { resetRouteTable } from "./route-table";
import { connectCurrentSite } from "./site-url";

/**
 * Real-Estate #16 (`handoff/warlock-5.22.1-scaffold-bugs.md`, item 16):
 * neither multi-site installer ever called `publishLocaleRouting()` — both
 * only published when `siteScope`/`siteSlice` was `undefined`, the
 * single-site path a multi-site install never takes. `readLocaleRouting()`
 * therefore always answered `{ strategy: "none" }`, so `<Link>`'s ambient
 * prefixing, `localizedPath()`, and the document's hydration-payload embed
 * (`resolveDocumentLocaleRouting`) all silently no-opped for every
 * multi-site app, regardless of a site's own configured strategy.
 *
 * Two sites, two strategies: "storefront" is `prefix-except-default` (en
 * default, ar prefixed); "docs" is `none`. Both installers are covered here
 * (dev's `installPageRoutes`, production's `installPageRoutesFromManifest`),
 * reusing the fixture shapes `server/site-dispatch.spec.ts` and the
 * "per-site locale routing" describe block in
 * `server/install-page-routes-from-manifest-locale-routing.spec.ts` already
 * use — including the `src/web/$sites/<key>/` site layout.
 */

const sites: SitesConfig = {
  storefront: { hosts: ["storefront.test"], localeRouting: { strategy: "prefix-except-default" } },
  docs: { hosts: ["docs.test"] },
};

type Captured = {
  site: string;
  strategy: LocaleRouting["strategy"];
  /** `localizedPath("/pricing", "ar")` — a literal path, explicit locale, no `readCurrentLocale()` involved. */
  localizedHomeForAr: string;
  /** A literal-path `<Link to="/pricing" locale="ar">`'s rendered `href`. */
  linkHref: string;
  /** What `render-page.ts` would embed on the document for this request. */
  documentLocaleRouting: LocaleRouting | undefined;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  vi.restoreAllMocks();
  resetRouteTable();
  resetLocaleRouting();
  connectCurrentSite(undefined);
  config.set("web", {});
  config.set("app", {});
});

function setUpConfig(): void {
  // No global `web.localeRouting`: "storefront" overrides the (absent, so
  // `"none"`) global per site; "docs" declares no `localeRouting` of its own
  // and so inherits that same `"none"` global — the two sites must still end
  // up with DIFFERENT resolved strategies, from their own site config alone.
  config.set("web", {});
  config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
}

/** One recorded render, keyed by `Fastify`-shaped fake request/response. */
function fakeRequest(host: string) {
  return {
    path: "/",
    method: "GET",
    protocol: "http",
    baseRequest: { hostname: host, params: {} as Record<string, string> },
    params: {} as Record<string, string>,
    setParam(key: string, value: string) {
      (this.params as Record<string, string>)[key] = value;

      return this;
    },
    site: undefined as unknown,
    locale: undefined as string | undefined,
    header: (name: string) => (name === "host" ? `${host}:2030` : undefined),
  };
}

function fakeResponse() {
  return {
    send: async () => undefined,
    header: () => undefined,
    html: async () => undefined,
    redirect() {
      return this;
    },
    permanentRedirect() {
      return this;
    },
  };
}

function recordingRouter() {
  const registered: { path: string; method: "GET" | "POST"; handler: PageRouteHandler }[] = [];
  const router = {
    get: (routePath: string, handler: PageRouteHandler) => {
      registered.push({ path: routePath, method: "GET", handler });
    },
    post: (routePath: string, handler: PageRouteHandler) => {
      registered.push({ path: routePath, method: "POST", handler });
    },
    withSourceFile: async <T>(_file: string, callback: () => T | Promise<T>) => callback(),
    list: () => [],
  } as unknown as Router;

  return { router, registered };
}

/** `handler` renders the site's home page and captures what a real render would read/embed. */
function captureHandlerOptions(options: PageRouteHandlerOptions, captured: Captured[]): PageRouteHandler {
  const match = /\$sites[\\/]([a-z]+)[\\/]/.exec(options.pageFile.replaceAll("\\", "/"));
  const site = match?.[1] ?? "";

  return async () => {
    const routing = readLocaleRouting();

    captured.push({
      site,
      strategy: routing.strategy,
      localizedHomeForAr: localizedPath("/pricing", "ar"),
      linkHref: (Link({ to: "/pricing", locale: "ar" }).props as { href: string }).href,
      documentLocaleRouting: resolveDocumentLocaleRouting("/", routing),
    });
  };
}

/** Renders one request through the real dispatch, inside the ALS scope it needs. */
async function renderThrough(handler: PageRouteHandler, host: string): Promise<void> {
  const context = { request: fakeRequest(host), response: fakeResponse() } as never;

  await coreRequestContext.run(context, () => handler(context));
}

async function installDev(captured: Captured[]) {
  vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(
    (options: PageRouteHandlerOptions) => captureHandlerOptions(options, captured),
  );

  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-locale-routing-multi-site-"));
  temporaryDirectories.push(appRoot);

  const modules: Record<string, unknown> = {};
  const write = (relative: string, module: unknown) => {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "export default function Page() { return null; }\n", "utf-8");
    modules[full] = module;
  };

  for (const key of Object.keys(sites)) {
    write(`src/web/$sites/${key}/root.tsx`, { default: () => null });
    write(`src/web/$sites/${key}/home.page.tsx`, { default: () => null, config: { route: "/" } });
  }

  const { router } = recordingRouter();
  const dispatch = createSiteDispatch({ sites });
  const siteDispatch: SiteDispatchInstall = { sites, dispatch };

  await installPageRoutes({
    router,
    vite: { ssrLoadModule: async (id: string) => modules[id] ?? { default: () => null } } as never,
    appSrcRoot: path.join(appRoot, "src"),
    appFile: path.join(appRoot, "src/web/root.tsx"),
    siteDispatch,
  } satisfies InstallPageRoutesOptions);

  return { dispatch };
}

function installProd(captured: Captured[]) {
  const entry = (key: string): PageManifestPageEntry => ({
    module: { default: () => null, config: { route: "/" } },
    sourceFile: `src/web/$sites/${key}/home.page.tsx`,
    layouts: [],
    site: key,
  });
  const manifest: PageManifest = {
    pages: Object.keys(sites).map(entry),
    sites: Object.fromEntries(
      Object.keys(sites).map((key) => [
        key,
        { app: { module: { default: () => null }, sourceFile: `src/web/$sites/${key}/root.tsx` } },
      ]),
    ),
  };

  const { router } = recordingRouter();
  const dispatch = createSiteDispatch({ sites });
  const siteDispatch: SiteDispatchInstall = { sites, dispatch };

  installPageRoutesFromManifest({
    router,
    manifest,
    createHandler: (options) => captureHandlerOptions(options, captured),
    siteDispatch,
  });

  return { dispatch };
}

describe.each<["dev" | "prod"]>([["dev"], ["prod"]])(
  "multi-site locale routing publish (%s)",
  (mode) => {
    it("publishes each site's OWN locale routing, so a request sees its site's strategy — never `none`, never another site's", async () => {
      setUpConfig();
      const captured: Captured[] = [];
      const { dispatch } = mode === "dev" ? await installDev(captured) : installProd(captured);
      const { router: dispatchRouter, registered } = recordingRouter();
      dispatch.register(dispatchRouter);
      const get = registered.find((route) => route.method === "GET");

      if (get === undefined) throw new Error("no GET dispatch route registered");

      await renderThrough(get.handler, "storefront.test");
      await renderThrough(get.handler, "docs.test");

      expect(captured).toHaveLength(2);

      const storefront = captured.find((entry) => entry.site === "storefront");
      const docs = captured.find((entry) => entry.site === "docs");

      // storefront: prefix-except-default — ar is prefixed, Link/localizedPath agree.
      expect(storefront?.strategy).toBe("prefix-except-default");
      expect(storefront?.localizedHomeForAr).toBe("/ar/pricing");
      expect(storefront?.linkHref).toBe("/ar/pricing");
      expect(storefront?.documentLocaleRouting).toEqual({
        strategy: "prefix-except-default",
        codes: ["en", "ar"],
        defaultLocale: "en",
      });

      // docs: no site-level override and no inherited "prefix" from the
      // global — stays bare, and embeds nothing for the document to hydrate.
      expect(docs?.strategy).toBe("none");
      expect(docs?.localizedHomeForAr).toBe("/pricing");
      expect(docs?.linkHref).toBe("/pricing");
      expect(docs?.documentLocaleRouting).toBeUndefined();
    });
  },
);
