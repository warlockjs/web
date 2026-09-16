/**
 * THE AUDIT SURFACE — everything the browser receives, declared by the app.
 *
 * Ships EMPTY and with NO index signature: `shared.anything` does not compile
 * until the application augments this interface (v5/app does at
 * `src/web/types.ts:23-59`). Required keys demand an unconditional middleware
 * writer; optional keys may be written conditionally.
 *
 * Declared HERE, in the entry module, and that placement is load-bearing:
 * applications augment the module `"@warlock.js/web"`, and TypeScript merges a
 * module augmentation only with interfaces declared in the module that
 * specifier resolves to — an interface re-exported through the barrel from a
 * concern file would NOT merge (microsoft/TypeScript#18877). The published
 * package's entry .d.ts must keep declaring it directly for the same reason.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SharedContext {}

export type { HttpContext, PageContext } from "./context";
export type { PageLoader, LayoutLoader, AppLoader } from "./loaders";
// Server-safe by construction (no React/react-dom import) — the `defer()`
// marker a page loader returns to stream data after the shell. Client
// bundle weight is unaffected: nothing in `./loaders/defer` imports
// anything client-only.
export { defer, isDeferred, DEFERRED_BRAND } from "./loaders/defer";
export type { DeferredResult } from "./loaders/defer";
export type { PageProps, LayoutProps, AppProps } from "./props";
export type {
  ErrorPageProps,
  SerializedErrorPageProps,
  SerializedPageError,
} from "./components/document-context";
export type { PageMetadata } from "./metadata";
export { shared, useShared } from "./shared";
export { LocaleProvider, useLocale, useTrans } from "./localization";
export type { LocaleProviderProps, Translate } from "./localization";
export { localeDirection } from "./text-direction";
export type { TextDirection } from "./text-direction";
export { useTextDirection } from "./use-text-direction";
export { href } from "./routing/route-table";
export type { RouteParameters, RouteQuery } from "./routing/route-table";
export { Link } from "./components/link";

// The navigation verbs carry `@mongez/react-router`'s NAMES on purpose (canon
// 9c8f878b): a developer moving between a Mongez CSR app and a Warlock SSR app
// should not relearn navigation. Parity stops at the matcher — there is no
// `router` export here and there must never be one, because two implementations
// of one route grammar diverge SILENTLY, as the wrong page rather than an error.
export { navigateTo, navigateBack, getHash } from "./client/navigation/verbs";

// `routerEvents` is the singleton a progress bar subscribes to from anywhere in
// the tree — or from outside React — without a bus being threaded through every
// intermediate component. It is safe to import on the SERVER: it holds listener
// registrations only, never render state or anything request-scoped, so two
// concurrent SSR requests learn nothing about each other from it.
// `createRouterEvents` is ours, not MRR's, and exists so tests get isolation.
export { routerEvents, createRouterEvents } from "./routing/router-events";
export type {
  NavigationStartPayload,
  NavigationEndPayload,
  NavigationErrorPayload,
} from "./routing/router-events";

// `currentRoute()` answers with what the SERVER matched, not with a client
// matcher's output — there is no client matcher and there must never be one.
// It is name-only today: the matched entry's `params` are not on the wire.
export { currentRoute, previousRoute } from "./client/navigation/current-route";
export type { MatchedRoute } from "./client/navigation/current-route";

// `refresh()` carries MRR's name and does strictly more: MRR re-renders the
// current route, this re-RUNS its loaders and then re-renders. It is canon
// The revalidate primitive — the thing you call after a successful POST.
// A FAILED refresh deliberately does not degrade to a full page load the way a
// failed navigation does: a navigation must reload because the user has to
// arrive, a refresh must not because the user is already there.
export { refresh } from "./client/navigation/refresh";

// `changeLocaleCode()` is the client-side locale switch: a data request
// for the current route with `?locale=<code>` on the FETCH URL only (the
// server persists the choice into its `locale` cookie on that same request —
// see `change-locale-code.ts`'s header for why the client never writes one
// itself), then the same tree-swap `refresh()` uses. No hook is exported: like
// `refresh()`, it needs no React context, only the module-level runtime
// `NavigationRoot` connects.
export { changeLocaleCode } from "./client/navigation/change-locale-code";

// The server-side page cache's invalidation half moved to the server-only
// subpath `@warlock.js/web/server` (`./server/page-cache.ts`). Its import
// graph reaches `@warlock.js/cache` (`./server/page-cache-driver.ts`'s
// `await import(...)`), a server-only `@warlock.js/*` package, and this
// barrel is reachable from client code (e.g. `root.tsx`) — Gate A refuses
// that chain, correctly. Import `invalidatePageCache` from
// `"@warlock.js/web/server"` instead.

// The DECODE half of the query encoder `href()` already uses. Deliberately not a
// second implementation: both directions stand on one `URLSearchParams` rule, so
// the writer and the reader cannot drift apart. `resetQueryStringOptions` is ours,
// for tests; MRR has no equivalent.
export {
  queryString,
  setQueryStringOptions,
  resetQueryStringOptions,
} from "./routing/query-string";
export type {
  QueryStringValue,
  QueryStringObject,
  QueryStringOptions,
  QueryStringInput,
  QueryStringLeaf,
  QueryStringNested,
  RepeatedKeyStrategy,
} from "./routing/query-string";

// The ENCODER, now living beside the decoder it must agree with — `href()`
// imports it from here rather than owning a private copy. One grammar, two
// directions: emit `tags[]=a`, `filter[status]=active`, and read them back the
// same way, because that is what core's own parser accepts
// (`core/src/http/request.ts:491` runs `request.query` through `parseBody`).
//
// `UnserializableQueryValueError` is thrown rather than encoded for shapes core
// would silently destroy — refusing to write a value beats writing one that
// arrives as something else.
//
// `connectRequestSearch` is the SAME boot-wiring seam `connectSharedStore`
// and `connectPageContext` are — a server bootstrap connects it once, the
// pipeline resolves it per request (`routing/query-string.ts`'s module
// header). `useQueryString` is the one caller most apps reach for: the
// hook itself lives in `client/` because it uses React, but it belongs on
// this surface for the same reason `href` does — nothing works until it can
// be imported.
export {
  queryStringOf,
  connectRequestSearch,
  UnserializableQueryValueError,
} from "./routing/query-string";
export type { RequestSearchResolver } from "./routing/query-string";
export { useQueryString } from "./client/navigation/use-query-string";
export { Head } from "./components/head";
export { Scripts } from "./components/scripts";

// A client-only rendering primitive: `fallback` on the server AND during
// hydration, `children` after mount, with no hydration mismatch — see
// `skills/render-client-only/SKILL.md` for the module-loading distinction
// this pairs with (`React.lazy` inside `<ClientOnly>`).
export { ClientOnly } from "./components/client-only";
export type { ClientOnlyProps, ClientOnlyChildren } from "./components/client-only";
export { useIsClient } from "./components/use-is-client";

// The build→runtime handoff surface (page manifest, build contribution) is
// NOT re-exported here: this barrel's graph reaches React, and a config file
// that merely constructs a connector must not. It lives at `@warlock.js/web/connector` — `src/connector/index.ts`.
