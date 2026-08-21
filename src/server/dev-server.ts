/**
 * Real Vite middleware-mode dev server, mounted on core's real Fastify
 * instance (`core/src/http/server.ts`'s `startHttpServer()`), rendering
 * v5/app's real page files through `renderPageRequest`
 * (`web/src/server/render-page.ts`) via `vite.ssrLoadModule` at request time.
 *
 * DELIBERATE EXCEPTION to A.3 §2 ("web has no core dependency" — see
 * `web/src/shared.ts`'s header comment): that rule protects the SHIPPED
 * package surface (`web/src/index.ts` / `web/src/server/index.ts`'s barrel,
 * `web/package.json`'s `dependencies`). This file is not exported from
 * either barrel and is not part of `web/package.json`'s dependency graph —
 * it is a dev/CLI bootstrap script that runs inside this monorepo checkout
 * exactly the way `web/__tests__/server/fixtures/core-http.ts` already
 * reaches core via a relative path (that file's own header comment records
 * the same reasoning). A published `@warlock.js/web` consumer never imports
 * this module; only `warlock dev`-style tooling that already depends on core
 * would.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ViteDevServer } from "vite";
import { requestContext } from "../../../core/src/http/context/request-context";
import { Request } from "../../../core/src/http/request";
import { Response } from "../../../core/src/http/response";
import { startHttpServer, type FastifyInstance } from "../../../core/src/http/server";
import { connectSharedStore } from "../shared";
import type { BufferedCookie } from "./buffered-response";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageRouteMatch,
  type PageTripleModule,
} from "./index";

/**
 * Explicit core `CookieOptions` (core/src/http/response.ts:37, `CookieSerializeOptions
 * & { raw }`) → fastify `setCookie` options mapping, field by field — the replacement
 * for the `as Parameters<FastifyReply["setCookie"]>[2]` cast this file used to reach
 * into a `BufferedCookie`'s loosely-typed `options` bag (`Record<string, unknown>`,
 * `web/src/server/buffered-response.ts:24`) and hand it to fastify unchecked.
 *
 * `maxAge` gets its own line deliberately: @fastify/cookie's own `SerializeOptions`
 * documents it as "A number in seconds"
 * (node_modules/@fastify/cookie/types/plugin.d.ts:122-123) — the SAME unit core's
 * `CookieOptions` uses (it extends `CookieSerializeOptions` directly, no conversion
 * layer). The locale cookie's `maxAge: 31536000` (C3 §8-A, canon `f9d9a5cc`) is
 * therefore passed through untouched — but doing that inside a typed, per-field
 * mapping (rather than a blanket cast) means a future unit mismatch on EITHER side
 * fails to compile here instead of silently reaching a real Set-Cookie header.
 *
 * `raw` is dropped, not forwarded: it is core-only (`Response.cookie()` consumes it
 * to choose `JSON.stringify` vs `String(value)` — see `serializeBufferedCookieValue`
 * below), and fastify's `setCookie` has no such option.
 */
export function mapCookieOptionsToFastify(
  options: Record<string, unknown> | undefined,
): CookieSerializeOptions {
  if (!options) return {};

  const fastifyOptions: CookieSerializeOptions = {};

  if (options.domain !== undefined) fastifyOptions.domain = options.domain as string;
  if (options.encode !== undefined) {
    fastifyOptions.encode = options.encode as (value: string) => string;
  }
  if (options.expires !== undefined) fastifyOptions.expires = options.expires as Date;
  if (options.httpOnly !== undefined) fastifyOptions.httpOnly = options.httpOnly as boolean;
  if (options.maxAge !== undefined) fastifyOptions.maxAge = options.maxAge as number; // seconds, both sides
  if (options.partitioned !== undefined) {
    fastifyOptions.partitioned = options.partitioned as boolean;
  }
  if (options.path !== undefined) fastifyOptions.path = options.path as string;
  if (options.sameSite !== undefined) {
    fastifyOptions.sameSite = options.sameSite as CookieSerializeOptions["sameSite"];
  }
  if (options.priority !== undefined) {
    fastifyOptions.priority = options.priority as CookieSerializeOptions["priority"];
  }
  if (options.secure !== undefined) {
    fastifyOptions.secure = options.secure as CookieSerializeOptions["secure"];
  }
  if (options.signed !== undefined) fastifyOptions.signed = options.signed as boolean;
  // `raw` intentionally has no branch here — see the doc comment above.

  return fastifyOptions;
}

/**
 * Mirrors core's own value serialization (`Response.cookie()`,
 * core/src/http/response.ts:958: `raw ? String(value) : JSON.stringify(value)`)
 * exactly. This is the fix for the encoding decision this file used to make
 * unilaterally via unconditional `String(cookie.value)`: for any committed cookie
 * NOT marked `{ raw: true }` (the default), production JSON-stringifies the value —
 * a plain string comes out quoted, a structured value comes out as its JSON form —
 * while `String(cookie.value)` silently disagreed (no quotes on a string, and
 * `"[object Object]"` for anything structured). `dev-server-cookie-drift.spec.ts`
 * is what checks this stays true, rather than trusting it by inspection.
 *
 * Percent-encoding of the resulting string is NOT this function's concern — that
 * happens one layer further out, inside fastify's `setCookie`/the `cookie` package's
 * own `serialize`, and is settled by canon as unconditional with no opt-out. Nothing
 * here touches it.
 */
export function serializeBufferedCookieValue(cookie: BufferedCookie): string {
  const raw = cookie.options?.raw === true;
  return raw ? String(cookie.value) : JSON.stringify(cookie.value);
}

/**
 * The one place a buffered cookie becomes a real Set-Cookie header — both
 * `/contact-us` and `/hydration-demo` call this instead of hand-rolling the
 * `setCookie` call (and its cast) twice.
 */
export function applyBufferedCookie(fastifyReply: FastifyReply, cookie: BufferedCookie): void {
  fastifyReply.setCookie(
    cookie.name,
    serializeBufferedCookieValue(cookie),
    mapCookieOptionsToFastify(cookie.options),
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** repo root: web/src/server/dev-server.ts -> web/src/server -> web/src -> web -> repo root. */
const REPO_ROOT = path.resolve(__dirname, "../../../");
const V5_APP_ROOT = path.join(REPO_ROOT, "v5/app");
const WEB_SRC_INDEX = path.join(REPO_ROOT, "web/src/index.ts");
const CORE_SRC_INDEX = path.join(REPO_ROOT, "core/src/index.ts");

/**
 * The ONE route this slice proves (brief step 6): the real
 * `v5/app/src/app/main/web/contact-us.page.tsx`, wrapped by the real
 * `v5/app/src/app/main/web/layout.tsx` and the real `v5/app/src/web/App.tsx`
 * — the app-root file lives OUTSIDE the `src/app/*` feature tree, at
 * `src/web/App.tsx` (confirmed by search: `App.tsx` does not exist anywhere
 * under `src/app`; it exists only at `src/web/App.tsx`; `v5/app/tsconfig.json`'s
 * own `paths` — `"web/*": ["web/*"]`, `"app/*": ["app/*"]` — name that exact
 * split).
 */
const CONTACT_US_ROUTE = {
  path: "/contact-us",
  name: "main.contact-us",
  files: {
    app: path.join(V5_APP_ROOT, "src/web/App.tsx"),
    layout: path.join(V5_APP_ROOT, "src/app/main/web/layout.tsx"),
    page: path.join(V5_APP_ROOT, "src/app/main/web/contact-us.page.tsx"),
  },
} as const;

/**
 * Vite middleware mode, `appType: "custom"` (brief step 2 — Warlock owns the
 * response shape; Vite never fronts Warlock, `design/request-lifecycle.md`).
 *
 * `root: V5_APP_ROOT` — empirically the only choice that resolves the real
 * page files correctly: `vite.ssrLoadModule` needs ABSOLUTE paths regardless
 * of root, but the page/layout files themselves import bare specifiers
 * (`"web/components/top-bar"`, `"@warlock.js/core"`, `"@warlock.js/web"`)
 * that only resolve if Vite's module graph starts scanning from v5/app's own
 * tree — rooting at `web/` (the framework package) instead would make Vite
 * apply v5/app's dependency optimizer scan to the WRONG project and never
 * see `v5/app/tsconfig.json`'s path aliases at all. The two bare-specifier
 * families v5/app's tsconfig declares (`web/*`, `app/*`, tsconfig.json's
 * `paths`) are NOT picked up by Vite automatically (no `vite-tsconfig-paths`
 * plugin is installed in this workspace — checked: absent from
 * `node_modules` and from every package.json in the tree) so they are
 * re-declared as explicit `resolve.alias` entries below, by hand, matching
 * the tsconfig source of truth exactly.
 *
 * `@warlock.js/web` and `@warlock.js/core` are ALSO aliased straight to their
 * TypeScript source barrels rather than left to Vite's normal node_modules
 * resolution: both packages declare `"main": "./esm/index.js"` and neither
 * has a built `esm/` in this checkout (`web/package.json:7`, confirmed via
 * `ls web/esm` / `ls core/esm` — both absent), and `node_modules/@warlock.js`
 * has no `web` symlink at all (checked: `access`, `auth`, `cache`, ...,
 * `seal` are linked; `web` is missing even though it is listed in the root
 * `package.json` workspaces array). Aliasing to source is also the only
 * choice consistent with Vite dev semantics elsewhere in this file: always
 * current source, no stale build.
 *
 * The REST of the `@warlock.js/*` siblings core's own source imports at
 * runtime (`seal`, `cascade`, `context`, `logger`, `cache`, `fs`, `auth`,
 * `herald`) hit the exact same unbuilt-package problem transitively — proven
 * empirically: the first run of this file without these aliases died on
 * `Cannot find package '.../node_modules/@warlock.js/context/index.js'`
 * (core's own `request-context.ts` importing `@warlock.js/context`). Rather
 * than re-derive the list by trial and error, this reuses the EXACT
 * workaround and alias set already established and documented for this
 * problem in `core/vitest.config.ts:13-28` / `web/vitest.config.ts:9-39` (the
 * latter using exact-match regexes over core's plain-string form specifically
 * so a subpath specifier like `@warlock.js/seal/validators/any-validator`
 * isn't corrupted — same reasoning applies here since v5/app source may do
 * the same).
 */
const WORKSPACE_SIBLINGS = [
  "seal",
  "cascade",
  "context",
  "logger",
  "cache",
  "fs",
  "auth",
  "herald",
  // Not in core/vitest.config.ts's or web/vitest.config.ts's list (core's own
  // unit suite never triggers this import path) — found empirically: the
  // FULL `core/src/index.ts` barrel (what `@warlock.js/core` is aliased to,
  // above) transitively evaluates every `connectors/*-connector.ts`, each of
  // which dynamically imports its own sibling package by bare specifier
  // (`grep -rn 'await import("@warlock' core/src`: access-connector.ts:39,57,
  // ai-connector.ts:41, herald-connector.ts:31,59 [herald already listed
  // above], notifications-connector.ts:38). Same unbuilt-esm problem, walked
  // exhaustively here rather than one alias at a time — see this task's
  // report for why aliasing `@warlock.js/core` to the full barrel (not a
  // narrower entry) surfaces the whole connector fan-out.
  "access",
  "ai",
  "notifications",
] as const;

const workspaceSourceAlias = (packageName: string) => ({
  find: new RegExp(`^@warlock\\.js/${packageName}$`),
  replacement: path.join(REPO_ROOT, packageName, "src/index.ts"),
});

async function createDevViteServer(): Promise<ViteDevServer> {
  const { createServer } = await import("vite");

  return createServer({
    root: V5_APP_ROOT,
    appType: "custom",
    server: { middlewareMode: true },
    // Without an explicit target, esbuild assumes the runtime supports
    // standard (TC39) decorators natively and leaves `@RegisterModel()`-style
    // syntax untouched — but this Node build has no native decorator support
    // (verified directly: even a bare `new Function("@dec class C{}")()`
    // throws `SyntaxError: Invalid or unexpected token` here), and Vite's SSR
    // module runner evaluates transformed code via `new AsyncFunction(...)`,
    // which hits that exact wall. `target: "es2022"` makes esbuild downlevel
    // decorators into real helper calls instead of passing the syntax through.
    esbuild: { target: "es2022" },
    // Optional peers `core/src/mail` reaches via `await import(...)`
    // (nodemailer, the AWS SES SDK, @react-email/render) are real published
    // packages with real dist output — nothing about them needs Vite's
    // transform, and they may not even be installed. Left un-externalized,
    // Vite's SSR module runner tries to resolve/transform them anyway and
    // dies ("transport was disconnected, cannot call fetchModule", a 30s
    // hang, not a clean error) — canon `5f684f28`: an optional peer loaded
    // via `await import()` must be declared external to every bundler and
    // SSR pipeline. `core` itself is NOT here — it has no built output yet
    // (the M1 finding), which is exactly why the alias list above exists.
    ssr: {
      external: ["nodemailer", "@aws-sdk/client-sesv2", "@react-email/render"],
    },
    resolve: {
      alias: [
        { find: /^web\//, replacement: `${path.join(V5_APP_ROOT, "src/web")}/` },
        { find: /^app\//, replacement: `${path.join(V5_APP_ROOT, "src/app")}/` },
        { find: /^@warlock\.js\/web$/, replacement: WEB_SRC_INDEX },
        { find: /^@warlock\.js\/core$/, replacement: CORE_SRC_INDEX },
        ...WORKSPACE_SIBLINGS.map(workspaceSourceAlias),
      ],
    },
  });
}

/**
 * Load the app/layout/page triple fresh, via `vite.ssrLoadModule`, EVERY
 * call — no module-level caching (brief step 5: dev semantics, always
 * current source). Each request's route entry is built from this, so the
 * `PageRouteEntry` handed to `renderPageRequest` per call is never reused
 * across requests either.
 */
async function loadContactUsTriple(
  vite: ViteDevServer,
): Promise<PageRouteEntry["triple"]> {
  const [app, layout, page] = await Promise.all([
    vite.ssrLoadModule(CONTACT_US_ROUTE.files.app),
    vite.ssrLoadModule(CONTACT_US_ROUTE.files.layout),
    vite.ssrLoadModule(CONTACT_US_ROUTE.files.page),
  ]);

  return {
    app: app as PageTripleModule,
    layout: layout as PageTripleModule,
    page: page as PageTripleModule,
  };
}

/**
 * Slice 4c — the hand-wired hydration proof (board task `549226c7`). ONE
 * page, deliberately no App/Layout: an empty triple slot (no `.default`) is
 * exactly what `wrapRootward` already treats as "use the framework default"
 * (`render-page.ts`), so `DefaultApp` supplies the `id="root"` mount this
 * proof hydrates into — not a new mount-point convention, the one that
 * already exists for the no-custom-App case.
 */
const HYDRATION_DEMO_ROUTE = {
  path: "/hydration-demo",
  name: "main.hydration-demo",
  page: path.join(V5_APP_ROOT, "src/app/main/web/hydration-demo.page.tsx"),
  clientEntry: "/src/app/main/web/hydration-demo.client.tsx",
} as const;

async function loadHydrationDemoTriple(
  vite: ViteDevServer,
): Promise<PageRouteEntry["triple"]> {
  const page = await vite.ssrLoadModule(HYDRATION_DEMO_ROUTE.page);

  return {
    app: {} as PageTripleModule,
    layout: {} as PageTripleModule,
    page: page as PageTripleModule,
  };
}

/**
 * `createHttp` mirrors `core/src/router/router.ts:924-932` exactly (minus
 * `setRoute`, which needs a core `Route` this hand-authored entry does not
 * have — the same omission `web/__tests__/server/fixtures/core-http.ts`
 * documents at its own top). Built fresh per call from the CURRENT request's
 * real fastify request/reply — never a shared/module-level pair.
 */
function createHttpForRequest(fastifyRequest: FastifyRequest, fastifyReply: FastifyReply) {
  return (_match: PageRouteMatch) => {
    const request = new Request();
    const response = new Response();

    response.setResponse(fastifyReply); // router.ts:927
    (request as any).response = response; // router.ts:928
    (response as any).request = request; // router.ts:930
    request.setRequest(fastifyRequest); // router.ts:932 (setRoute omitted, see above)

    return { request, response };
  };
}

export type DevServerHandle = {
  fastify: FastifyInstance;
  vite: ViteDevServer;
  port: number;
  close(): Promise<void>;
};

/**
 * Boots the real Fastify instance (`startHttpServer`), mounts Vite's
 * middleware stack onto it (brief step 3 — `vite.middlewares` is a plain
 * Connect `(req, res, next)` stack; Fastify's `request.raw`/`reply.raw` ARE
 * Node's `req`/`res`), wires the page pipeline's REAL (non-test) context —
 * `connectPageContext(requestContext)` / `connectSharedStore(() =>
 * requestContext.getStore())`, the exact pair
 * `web/__tests__/server/render-page-request.spec.ts`'s `beforeAll` already
 * proves works, called here for the first time OUTSIDE a test (see this
 * task's report for why that matters) — and registers the one `/contact-us`
 * route.
 */
export async function startDevServer(options: { port?: number } = {}): Promise<DevServerHandle> {
  const vite = await createDevViteServer();
  const fastify = startHttpServer();

  connectPageContext(requestContext as unknown as PageContextRunner);
  connectSharedStore(() => requestContext.getStore() as any);

  fastify.addHook("onRequest", (request, reply, done) => {
    vite.middlewares(request.raw, reply.raw, done);
  });

  fastify.get(CONTACT_US_ROUTE.path, async (fastifyRequest, fastifyReply) => {
    // `vite.ssrLoadModule` errors (a real page/layout/App file failing to
    // parse or evaluate — see this task's report for two such REAL, upstream
    // blockers found for this exact route) and `render-page.ts`'s
    // `finishRender` (which has no try/catch around `renderToString`) both
    // otherwise surface as an opaque Fastify 500 with no server-side trace.
    try {
      const triple = await loadContactUsTriple(vite);
      const routes: PageRouteEntry[] = [
        { path: CONTACT_US_ROUTE.path, name: CONTACT_US_ROUTE.name, triple },
      ];

      const rendered = await renderPageRequest(fastifyRequest.url, {
        routes,
        createHttp: createHttpForRequest(fastifyRequest, fastifyReply),
      });

      for (const cookie of rendered.cookies) {
        applyBufferedCookie(fastifyReply, cookie);
      }

      fastifyReply.code(rendered.status).headers(rendered.headers).send(rendered.html);
    } catch (error) {
      fastifyRequest.log.error({ err: error }, "dev-server: /contact-us render failed");
      throw error;
    }
  });

  // Slice 4c (board task 549226c7): the hand-wired hydration proof route.
  // This is a hand-wired, single-page proof, not a general mechanism — the
  // script tag is injected here, for this one route, rather than added to
  // `<Scripts/>`/`DefaultApp` generally, which would be inventing the real
  // client-runtime wiring ahead of the spike this task explicitly defers to.
  fastify.get(HYDRATION_DEMO_ROUTE.path, async (fastifyRequest, fastifyReply) => {
    try {
      const triple = await loadHydrationDemoTriple(vite);
      const routes: PageRouteEntry[] = [
        { path: HYDRATION_DEMO_ROUTE.path, name: HYDRATION_DEMO_ROUTE.name, triple },
      ];

      const rendered = await renderPageRequest(fastifyRequest.url, {
        routes,
        createHttp: createHttpForRequest(fastifyRequest, fastifyReply),
      });

      for (const cookie of rendered.cookies) {
        applyBufferedCookie(fastifyReply, cookie);
      }

      const scriptTag = `<script type="module" src="${HYDRATION_DEMO_ROUTE.clientEntry}"></script>`;
      const html = rendered.html.replace("</body>", `${scriptTag}</body>`);

      fastifyReply.code(rendered.status).headers(rendered.headers).send(html);
    } catch (error) {
      fastifyRequest.log.error({ err: error }, "dev-server: /hydration-demo render failed");
      throw error;
    }
  });

  const port = options.port ?? 0;

  await fastify.listen({ port, host: "127.0.0.1" });

  const address = fastify.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    fastify,
    vite,
    port: actualPort,
    async close() {
      // `startHttpServer()` configures `forceCloseConnections: "idle"`
      // (core/src/http/server.ts:34), but requests answered by Vite's connect
      // middleware are written straight to `reply.raw`, bypassing Fastify's
      // reply lifecycle — Fastify never observes those requests completing,
      // so their keep-alive sockets are never counted idle and an "idle"-only
      // force close waits on them forever (reproduced: `fastify.close()`
      // alone hangs past the 30s hook timeout in
      // web/__tests__/server/dev-server.spec.ts's afterAll). A dev server has
      // no draining obligation, so drop every socket outright before closing.
      fastify.server.closeAllConnections();
      await fastify.close();
      await vite.close();
    },
  };
}
