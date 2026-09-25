---
description: "Server-rendered React pages for a Warlock app, with Vite. Exports `defer`, `useTrans`, `LocaleProvider`, `Link`, `href`, `navigateTo`, `refresh`, `shared`, `useShared`, `PublicPageError`, plus `Head` and `ClientOnly`. Use for: add a page, add SSR to an app, load data for a page, stream slow data, add a layout, change the HTML document, translate a page, link or navigate between pages, submit a form, handle a form action, protect a page, read the signed-in user, serve a sitemap, add a theme, ship CSS. Not this package: API routes, controllers, mail, storage → @warlock.js/core; database queries → @warlock.js/cascade; form input rules → @warlock.js/seal."
---
# @warlock.js/web

Web adds an SSR React page layer to a Warlock app. Pages live under `src/web/**` as `*.page.tsx` files; each declares its route, middleware, validation, and metadata in a `config` export and fetches data in a named loader. The server renders the shell, the browser hydrates, and navigation verbs re-run loaders through the server. There is no client-side route matcher; the server decides what matched.

## The 80% path
1. Install the layer with `warlock add web` (`add-web-to-an-app.md`), then edit the document in `src/web/root.tsx` (`write-the-root.md`).
2. Create pages with `config` and a loader (`create-a-page.md`, `load-page-data.md`); wrap them with `use-layouts.md`.
3. Link and navigate with `<Link>`, `href()`, `navigateTo` (`navigate-on-the-client.md`).
4. Post forms to a Core API route (`submit-a-form.md`), then `refresh()` to revalidate; or handle a form on the page itself with an `action` export and `<Form>` (`handle-a-form-action.md`).
5. Guard pages and read the user (`protect-a-page.md`).
6. Translate pages (`localize-pages.md`); stream slow data (`stream-deferred-data.md`).
7. Polish: styles (`serve-styles.md`), sitemap and robots (`generate-sitemap.md`), themes (`multi-theme.md`), client-only UI (`render-client-only.md`), vitals (`measure-web-vitals.md`).

## Conventions and pitfalls
- Route, cache, validation, middleware, metadata and sitemap policy go in `config`; keep loaders for data only.
- Anything the browser receives via `shared` must be declared by augmenting `SharedContext` in module `"@warlock.js/web"`.
- Server-only helpers live on subpaths (`@warlock.js/web/build`, `/sitemap`, `/form`, `/connector`); importing them from the root barrel breaks page graphs.
- Only `PublicPageError` messages reach the browser in production; other errors are sanitized.
- Cascade is server-only: value-importing it in client code fails the build (type imports are fine).
- Do not add a client router or matcher; two matchers diverge silently.
