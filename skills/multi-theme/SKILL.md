---
name: multi-theme
description: 'Serve a different theme per request (per host or tenant) from one app: middleware resolves the theme into `shared`, the page renders a component from a static `lazy(() => import(...))` map, `linkStylesheetsFor()` puts only the active theme''s CSS into the server-rendered `<head>`, and the server page cache keys by host (plus `config.cache.varyBy`) so tenants never share an entry. Triggers: `linkStylesheetsFor`, `UnknownStylesheetSourceError`, `InvalidStylesheetSourceError`, `varyBy`, "multi-tenant theme", "theme per host", "white-label store", "lazy theme component", "theme CSS flashes unstyled", "only load the active theme CSS", "cache per tenant". Skip: general CSS delivery — `@warlock.js/web/serve-styles/SKILL.md`; `shared` basics — `@warlock.js/web/load-page-data/SKILL.md`; page cache basics — `@warlock.js/web/create-a-page/SKILL.md`; runtime CSS-in-JS theme engines.'
---

# Warlock — one app, a theme per request

The framework does not ship a theme engine. It guarantees three things for a theme you pick per request: the choice reaches the browser without a hydration mismatch, only that theme's CSS is render-blocking in the first document, and the page cache never serves one tenant's theme to another.

## 1. Resolve the theme in middleware, publish it through `shared`

```ts title="src/web/themes/index.ts"
import { lazy } from "react";

export const themes = {
  alpha: lazy(() => import("./alpha/alpha-theme")),
  beta: lazy(() => import("./beta/beta-theme")),
};

export type ThemeId = keyof typeof themes;

/** App-root-relative source of each theme module, for linkStylesheetsFor(). */
export const themeSources: Record<ThemeId, string> = {
  alpha: "src/web/themes/alpha/alpha-theme.tsx",
  beta: "src/web/themes/beta/beta-theme.tsx",
};

declare module "@warlock.js/web" {
  interface SharedContext {
    theme: ThemeId;
  }
}
```

Each `themes[id]` entry lazily imports a plain component module — nothing framework-specific about it:

```tsx title="src/web/themes/alpha/alpha-theme.tsx"
import "./alpha.css";

export default function AlphaTheme() {
  return <main className="theme-alpha">Alpha storefront</main>;
}
```

```tsx title="src/web/themes/beta/beta-theme.tsx"
import "./beta.css";

export default function BetaTheme() {
  return <main className="theme-beta">Beta storefront</main>;
}
```

```tsx title="src/web/root.tsx"
import { Head, Scripts, linkStylesheetsFor, shared } from "@warlock.js/web";
import type { AppProps, HttpContext, RootConfig } from "@warlock.js/web";
import { themeSources, type ThemeId } from "./themes";

const selectTheme = async ({ request }: HttpContext) => {
  const theme: ThemeId = String(request.header("host", "")).startsWith("beta.") ? "beta" : "alpha";

  shared.theme = theme;
  linkStylesheetsFor(request, themeSources[theme]);
};

export const config = { middleware: [selectTheme] } satisfies RootConfig;
```

Each theme imports its own stylesheet (`import "./alpha.css";`). Never inline a `<style>` tag.

## 2. Render from the map

```tsx title="src/web/home.page.tsx"
import { Suspense } from "react";
import { useShared } from "@warlock.js/web";
import { themes } from "./themes";

export default function HomePage() {
  const Theme = themes[useShared().theme];

  return (
    <Suspense fallback={null}>
      <Theme />
    </Suspense>
  );
}
```

- Read the theme from `useShared()` only. Never re-derive it on the client (`location.host`), or the client may pick a different theme than the server rendered.
- Keep the map static: one literal `import()` per theme. Vite then emits one chunk plus one CSS file per theme. A computed specifier such as ``import(`./themes/${id}`)`` is not supported.

## 3. CSS: `linkStylesheetsFor(request, sourceFile)`

The server cannot see which lazy module rendered, and it never follows `dynamicImports` because that would ship every theme's CSS. Without a declaration, the theme's CSS arrives only from client JS after an unstyled first paint. The declaration fixes that for this response:

- The id is the module's app-root-relative POSIX path. Absolute paths, `./`, `..`, backslashes and queries throw `InvalidStylesheetSourceError`.
- Dev resolves the file's CSS imports (and transitive CSS once Vite's graph is warm). Production reads the Vite manifest. An unknown id throws `UnknownStylesheetSourceError` rather than silently shipping unstyled.
- The links come after the route's own stylesheets, deduped. `<head>` is not hydrated, so they cannot cause a mismatch.

## 4. Page cache

```ts
import type { PageConfig } from "@warlock.js/web";

export const config = {
  route: "/",
  cache: {
    public: true,
    maxAge: 60,
    serverCache: true,
    tags: (_data, { shared }) => [`theme:${shared.theme}`],
  },
} satisfies PageConfig;
```

- The key always includes the request host, so tenants on different hosts never share an entry.
- If the theme depends on something other than host (a preview cookie), add `varyBy: (request) => String(request.cookie("preview_theme") ?? "")`. It runs before middleware, so read the request directly.
- `invalidatePageCache(["theme:alpha"])` evicts one theme's pages.

## Gotchas

- **Middleware runs after the cache lookup.** Anything the key needs must come from the request (host, `varyBy`), not from `shared`.
- **Keep `themeSources` next to the map.** A path typo fails the request loudly in both dev and prod.
- **`import type {} from "./types"` in `root.tsx` is refused by projection.** Put the `SharedContext` augmentation in a module the root already imports.
