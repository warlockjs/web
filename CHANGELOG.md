# Changelog

All notable changes to `@warlock.js/web` are documented here.

## 5.2.3 - 2026-09-02

### Fixed

- The generated Web starter now projects and hydrates unchanged with one `index` page identity, universal localization registration, and deterministic browser markup.

## 5.2.2

### Fixed

- Restored exact Core and Seal peer pins at the family's shared 5.2.2 version.
  The partial 5.2.1 release could not satisfy reciprocal family peer pins.

## 5.2.1

### Fixed

- Tightened the Core and Seal peer ranges to `^5.2.0`. Web 5.2 production
  code imports Core APIs that were not available in Core 5.0, while the former
  Seal `*` range promised compatibility across unrelated major versions.

## 5.2.0

### Added

- **`error.page.tsx`** — the application's one error boundary. It renders when
  a middleware, loader, or component throws; declares no `route`, exactly like
  `404.page.tsx`; and a second `error.page.tsx` anywhere beneath `src/web` is a
  build error. Its component receives `{ error, status }` — the real thrown
  value during SSR, a JSON-safe `{ name, message, stack? }` after hydration.
  `robots: noindex` is a framework default on this path and cannot be
  overridden away. If the failure happens before any page module could load —
  a module-load or `register()` throw — the response falls back further, to a
  framework-owned boundary with no application code at all, and is served
  without a hydration script rather than risk hydrating against markup nothing
  can vouch for.
- **A page's `route` export is now optional.** A `*.page.tsx` with no `route`
  derives its path and its name from its location beneath `src/web`:
  directories contribute segments, `(group)` directories contribute nothing,
  `index.page.tsx` claims its own directory, and `[id]` becomes `:id`. An
  explicit `route` still always wins over the derived one. This replaces the
  5.1 behaviour, where an omitted `route` threw `MissingRouteExportError` at
  install time — that error class no longer exists.
- **Live page-route re-registration in `warlock dev`.** Creating, deleting, or
  editing a page's `route` export used to require a manual restart to take
  effect — the route table was built once at boot and never again, so a
  renamed route kept serving its old path and a deleted page kept 404-ing at
  its old URL forever. The dev connector now re-registers the affected routes
  in place, atomically, with no dev-server restart and no loss of Vite's HMR
  state. A component-body-only edit still takes the ordinary Fast Refresh
  path; only membership and route-identity changes go through this path.
- **A dev-only diagnostic for a page file that exists but isn't reachable.**
  When a request 404s, Warlock checks whether an unregistered `*.page.tsx`
  under `src/web` would have matched it, and if so, warns naming the file.
  This is the case that used to be silent: a page created after boot, or one
  whose `route` was edited to a path nothing else claims, previously 404'd
  with no explanation anywhere in the terminal.
- **`export const register`** — an optional, synchronous, no-argument hook on
  `root.tsx`, `layout.tsx`, and `*.page.tsx`. It runs once per module
  namespace instance, on both the server and the browser, before that
  module's middleware or loader — the seam for one-time setup a page or
  layout needs on both sides of hydration. It must not return a Promise;
  returning one throws.

### Changed

- **Page requests now tolerate one trailing slash identically in development
  and production.** `/about` and `/about/` serve the same page; `/` remains the
  root path and case handling is unchanged. Previously the development
  dispatcher accepted the slash while the production Fastify route returned
  404.

- ⚠ **BREAKING — `process.env` is refused entirely in the client/universal
  graph, and there is no `PUBLIC_` exception.** Neither a static key
  (`process.env.PUBLIC_API_URL`) nor a computed one (`process.env[key]`) is
  allowed: `process` does not exist in a browser, so there is no such thing as
  a "public" `process.env` key. **Bare value-reads of the object now fail
  too** — `const { X } = process.env`, `{ ...process.env }`,
  `Object.keys(process.env)`, `JSON.stringify(process.env)`, or passing it as
  an argument — which is the case that previously let an entire server
  environment reach a component in one line while every keyed read was being
  refused. `globalThis.process.env`, `window.process.env` and
  `process["env"]` are matched as well.

  **Enforcement now covers dev SSR as well as the client bundle, and a
  violation fails the build** rather than being a production-only surprise.
  Files under `node_modules` stay out of scope by design — a dependency's own
  `process.env.NODE_ENV` guard is not the application's problem.

  ⚠ **`env("PUBLIC_X")` does not work client-side either**, and never did:
  `env` comes from `@warlock.js/core`, which declares itself server-only, so
  the import is refused before the call is ever examined. **The supported
  pattern is to read the value in a page loader — server code — and pass it to
  the page as loader data:**

  ```tsx
  export const loader = (async () => ({
    siteName: env("PUBLIC_SITE_NAME"),
  })) satisfies PageLoader;

  export default function HomePage({ data }: PageProps<typeof loader>) {
    return <h1>{data.siteName}</h1>;
  }
  ```

  If a value must genuinely be inlined into browser code instead of passed as
  loader data, the one supported spelling is `import.meta.env.PUBLIC_*` with a
  static key — Vite's env surface, baked in at build time, so it cannot vary
  per request. Server-side code is unrestricted.

- ⚠ **BREAKING — a `*.page.tsx` with no default export is now a hard
  discovery/build failure, naming the file.** It previously built and
  registered, then served a blank `200` at its URL — a page that looked
  deployed, rendered nothing, and produced no error anywhere.

  ```
  The page "src/web/contact.page.tsx" has no runtime default export. Every
  `*.page.tsx` file must default-export the React component it renders.
  ```

  `export { Page as default }` satisfies the rule — the check is for a runtime
  default binding, not for the keyword form. `export default interface Page {}`
  does not: a type-only default is erased and leaves no component behind. A
  file that cannot be parsed reports as a parse failure instead, so a syntax
  error never masquerades as a missing export.

- **Initial stylesheet links are route-scoped in development and production.**
  Each response now links the ordered, deduplicated CSS chain for its own
  `[root, ...matched layouts, page]`. Production follows those source entries
  and their static imports in Vite's manifest instead of collecting CSS across
  the whole application; development promotes direct stylesheet imports from
  the matched page and layouts as well as the root. Unrelated page CSS no
  longer ships on every response, and page-local critical CSS no longer waits
  for hydration in development.
- **The production static-asset refusal now names the working 5.2 alternative.**
  Imported non-stylesheet assets still work under Vite in development but are
  refused by the esbuild server bundle rather than risk a server/client URL
  mismatch. The diagnostic now tells the developer to place the file under the
  application's `public/` directory and reference its root URL
  (`public/logo.svg` → `/logo.svg`) instead of waiting for an unspecified future
  server build. Stylesheet imports remain supported.
- **Loader execution is sequential, root to leaf, and terminal responses stop
  lower work.** The `root.tsx` App loader runs first, followed by every matched
  layout loader from outermost to innermost, then the page loader. The runtime
  has three top-level slots (`app`, `layout`, `page`), but the layout slot
  composes the full matched layout chain. A page still has at most one
  *rendering* layout; loader-only and middleware-only layouts may appear at
  multiple ancestry levels.

  ⚠ **This package's own documentation previously described the three levels as
  running in parallel, and told you not to rely on ordering between them.** The
  implementation now awaits the App slot, the composed outer-to-inner layout
  slot, and the Page slot in that order.

  **The first core `Response` a loader returns is terminal**: it stops every
  lower loader from starting, and — because the response is returned whole — it
  also bypasses buffer commit and metadata resolution, discarding the header
  and cookie writes buffered at that same level. A short-circuit
  (`response.redirect()`, `response.notFound()`) commits its own level's buffer
  inclusively and is the right choice when those writes should survive; a throw
  discards the throwing level's buffer and commits only the levels above it.

- **Catch-all page routes are documented as unsupported.** `[...slug].page.tsx`
  does not do what it looks like: filesystem routing recognizes only `[name]` as
  a dynamic segment, so `[...slug]` is taken as a **literal** segment and derives
  the path `/docs/[...slug]` and the name `docs.[...slug]` — reachable only at
  the literal URL `/docs/%5B...slug%5D`. ⚠ **Nothing warns about it**: no build
  error, no dev warning, no refusal, just a page that answers a URL nobody will
  request. A real catch-all is deferred; until then use a terminal wildcard with
  an explicit route (`route = { path: "/docs/*" }`). This entry records the gap,
  it does not close it.

- **`src/web` is the only page root.** A per-module `src/app/<module>/web/`
  tree is no longer discovered, walked, or installed as a page root by either
  `warlock dev` or `warlock build`. Move any page, layout, or root file that
  lived under `src/app/<module>/web/` into `src/web/` (a subdirectory is
  fine — it still contributes a route segment the same way).

### Fixed

- **A custom `404.page.tsx` loader no longer executes.** The not-found page
  still registers and renders its real module namespace, but its request
  triple omits the page loader in both development and production. A missing
  URL therefore cannot trigger application data work, redirect, or fail a
  second time through the fallback itself.

  Precisely what is skipped, because "the 404 page doesn't run loaders" is a
  useful shorthand and not the whole rule: only the **page-level `loader`** is
  omitted. The real module namespace is still used, so `register()` runs and
  the component renders normally, and the page's **middleware still runs**.
  Layout loaders don't run because this page has an empty layout chain by
  construction, not because loaders are disabled on it. And the **`root.tsx`
  App loader does still run** on a 404 request — keep it cheap, and make sure
  it tolerates a request that matched nothing.

## 5.1.0

> **Upgrade if you installed 5.0.0, 5.0.1 or 5.0.2.** React did not execute at all in
> a published install of any of them — see the first entry under *Fixed*. Every
> interactive page shipped on those versions was inert in the browser.

### Added

- **`404.page.tsx`** — an app-owned not-found page. It renders only when `text/html`
  is explicitly present in the request's `Accept` header, so an unmatched `/api/...`
  path still returns the JSON 404 an API client expects rather than a document. It
  renders with no layouts: discovery reports an empty layout chain for this page only,
  so the client hydration registry matches what the server has always rendered instead
  of wrapping a failure page in chrome that can itself throw or need data. Ordinary
  pages beside it keep their full layout chain, and nested-layout refusal on its path
  is unchanged.
- **`export const metadata` is typed (`PageMetadata`) and checked at build time.** An
  unannotated object literal with a misspelled key — `{ tittle: "x" }` — now fails the
  build, naming the file, the line and the offending key. It previously typechecked as
  a plain object and was silently ignored at runtime.
- **Fast Refresh in dev now applies only when an edit is confined to component
  bodies.** Any module-level change — an import, a module-level declaration, or any
  server export, `metadata` included — forces a full page reload instead of a stale hot
  update; a JSX-only edit still hot-updates in place with component state intact.

### Changed

- **`warlock dev` now refuses a `*.page.tsx` that exports no route**, throwing
  `MissingRouteExportError` and naming the file. It previously 404'd silently, so a
  missing `export const route` looked like a routing bug at request time. This matches
  what `warlock build` already did — dev and build now reject the same file.

### Removed

- **A false comment shipped in 5.0.0 through 5.0.2** claiming that a page's route is
  derived from its file location. No such derivation has ever existed in this package;
  the route comes from the page's `route` export and nothing else. The comment is gone
  from the scaffold emitted by `warlock add web`, but **every app scaffolded on 5.0.0,
  5.0.1 or 5.0.2 still carries it in its own source** — delete it by hand.

### Fixed

- **React did not run at all in published installs of 5.0.0 through 5.0.2.** The dev
  Vite server served `react-dom/client` as raw CJS, so `hydrateRoot` did not exist and
  the hydration module threw while being parsed. This one defect is the cause of all
  four symptoms reported against those versions: `useState` never updated, Fast Refresh
  never ran, metadata never refreshed, and `<Link>` fell back to a full page reload.
  Fixed by declaring the React entries in the dev server's `optimizeDeps` so they are
  pre-bundled to ESM before the browser asks for them. This is not a hydration
  *improvement* — hydration did not happen.
- **The browser was loading two copies of every `@warlock.js/web` client module.**
  Module-level state (context, the navigation runtime) existed twice, so a value written
  through one copy was invisible to the component reading the other.

## 5.0.2 - 2026-08-25

### Fixed

- **`<Head/>` read an empty document context under SSR.** The connector now sets
  `ssr.noExternal: ["@warlock.js/web"]` in `web-connector.ts`. Without it the server
  loaded two instances of this package — one externalised, one bundled — so the context
  the renderer wrote to was not the one `<Head/>` read from. A published 5.0.1 install
  that returned 500 on a page request returns 200 after this fix.

## 5.0.1 - 2026-08-25

### Changed

- Narrowed the `vite` peer dependency to `">=7.3.5 <8"`, so a consumer resolving vite
  for this package cannot land on a version outside the range it is built against.

### Fixed

- Internal: a test in `gate-b-secrets.spec.ts` depended on the ambient `NODE_ENV` and
  failed depending on how the suite was invoked. No runtime behaviour changed.

## 5.0.0 - 2026-08-25

**First published release.**

### Added

- SSR React pages with hydration, client navigation, route metadata, shared data, and Vite integration.

### Changed

- The hydration runtime is packaged as its own public entry, and production/dev route wiring now resolves the packaged client manifest and stylesheets.

## 4.16.0

**First published release.** The package existed in the monorepo but was absent
from the release registry, so it had never reached npm.

### Added

- SSR React pages served by the Warlock HTTP server. A page route is an ordinary
  Warlock route whose handler renders React instead of returning JSON.
- Hydration, and client-side navigation via `<Link>` — no document reload, Back
  and Forward included.
- React Fast Refresh in `warlock dev`, including a server render that reflects
  the edit rather than the pre-edit module.
- Typed links: `href(name, params, query)`; an unknown route name is a compile
  error.
- `revalidate()` — re-run the current route's loaders after a mutation.
- MRR's navigation API mirrored by name (`navigateTo`, `navigateBack`,
  `currentRoute`, `queryString`, …) without depending on that package.
- `warlock add web` scaffolds `src/web/` and registers the connector.

### Fixed

- `metadata()` no longer runs when a loader rejected. It used to be called with
  `data: undefined` while the type promised otherwise, so a metadata function
  reading its data threw a `TypeError` that **replaced the loader's real error**
  and pointed at the wrong file.
- Validation reads the same query the loader reads. Stage 4 took `query` and
  `params` from a hand-parsed URL while `body` and `headers` came from the
  request — so `?tags=a&tags=b` reached validation as `"b"`, and a rule on
  `filter.status` never fired because validation saw a key literally named
  `filter[status]`.
- `href()` emits the query grammar core actually parses; nested objects and
  arrays are no longer destroyed by `String(value)`.
