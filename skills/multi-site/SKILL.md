---
name: multi-site
description: 'Configure one @warlock.js/web app to serve several fixed-host and resolver-selected sites from `src/web/$sites/<name>/`: separate roots, `web.sites`, `web.resolveHost`, `resolveCache`, `basePath`, `unknownHost`, and `request.site`. Use for: marketing plus dashboard domains, white-label tenant domains, or tenant admin under a host path. Not this package → API host restrictions and middleware: @warlock.js/core; tenant query scoping: @warlock.js/cascade; per-tenant theme rendering: the `multi-theme` topic.'
---

# One app, multiple sites

Use `web.sites` when one Web deployment needs separate documents and route tables by host. This is opt-in; without it, the normal single `src/web/root.tsx` layout remains unchanged.

## 1. Give every site a folder and root

```text
src/web/
  $sites/
    landing/root.tsx
    landing/index.page.tsx
    platform/root.tsx
    tenant/root.tsx
    tenantAdmin/root.tsx
  components/
```

The folder name is the site key, and neither `$sites` nor the site folder appears in URLs. Each configured site folder needs its own `root.tsx`; it also holds that site's 404/error pages and routes. Shared components can live outside `$sites`, but pages cannot. Do not leave a top-level `src/web/root.tsx` in multi-site mode.

## 2. Declare fixed and dynamic sites

```ts title="src/config/web.ts"
import type { WebConfigurations } from "@warlock.js/web";

const web: WebConfigurations = {
  sites: {
    landing: {
      hosts: ["estates.app", "www.estates.app"],
      localeRouting: { strategy: "prefix-except-default" },
    },
    platform: { hosts: ["app.estates.app"] },
    tenant: { dynamic: true, localeRouting: {} },
    tenantAdmin: { dynamic: true, basePath: "/admin" },
  },
  resolveHost: async ({ host, request }) => {
    const domain = await findTenantDomain(host);
    if (!domain) return null;
    return {
      site: domain.kind === "dashboard" ? "tenantAdmin" : "tenant",
      key: String(domain.tenantId),
      indexable: domain.tenant.isPublic,
      shared: { theme: domain.tenant.theme },
    };
  },
  resolveCache: { ttl: 60 },
  unknownHost: "not-found",
  tlsAsk: "/.well-known/warlock/domain",
};

export default web;
```

Upgrade: move each `src/web/(group)` site folder to `src/web/$sites/<key>` and delete `pages` from `web.sites`. Fixed `hosts` are exact lowercase hostnames without ports; list `www` separately. A site uses either `hosts` or `dynamic: true`, never both. The exact listed host is selected before the resolver is called.

## 3. Keep resolver identity deliberate

`resolveHost` receives a normalized `{ host, request }` and returns `{ site, key, indexable?, shared? } | null`. Its `site` must name a dynamic site. `null` is a 404; a throw is a 500. `key` partitions tenant state and cache identity, so use a durable tenant identifier rather than a display name.

`resolveCache.ttl` is measured in seconds and caches by host only. It is disabled by default because a resolver that reads cookies or headers cannot be safely shared across visitors. Enable it only for host-only lookup results.

`basePath` selects a site below a path prefix; the longest matching prefix wins. `unknownHost` is `"not-found"` by default, or may name a configured fallback site. During development use hosts such as `acme.localhost:2030`.

`localeRouting` on a site replaces global `web.localeRouting`; omit it to inherit, and use `{}` to disable it for one site. Locale codes and the default locale still come from `app.localeCodes` and `app.localeCode`.

## 4. Read the result in a page handler

```ts
import type { PageLoaderContext } from "@warlock.js/web";

export async function loader({ site }: PageLoaderContext<undefined, undefined>) {
  if (!site?.tenantKey) return { tenant: null };
  return { site: site.key, tenant: await loadTenant(site.tenantKey) };
}
```

`ctx.site` is a `PageSite`, available in loaders and actions in multi-site mode. It has `key`, `host`, `basePath`, and `tenantKey` for a resolver-selected site. The resolver's `shared` fields merge into the regular shared payload before page middleware; use that for a theme hand-off, then follow `multi-theme` for rendering and CSS.

## 5. Route and error rules

Same paths in different sites are valid. Generated route names always get the site-key prefix (`landing.pricing`, `tenant.listings.show`), while explicit names are global. `href()` returns an absolute URL across sites; a dynamic target requires `{ $host: "tenant.example" }`, used only as its origin. `siteUrl()` returns the current origin plus the site's `basePath`.

```ts
const tenantListing = href("tenant.listings.show", { $host: "acme.estates.app", id: "42" });
const originAndMount = siteUrl();
```

`<Link to="platform.home">` and `navigateTo()` take the same names; a link to another site loads that site in full. `src/config/web.ts` may import the resolver from `app/...`: `warlock build` resolves the alias when it reads `web.sites`.

With sitemap and robots enabled, `/sitemap.xml` and `/robots.txt` are selected per site. A dynamic site is indexable only when its resolver result says `indexable: true`; otherwise its sitemap is a 404 and robots disallows crawling. Set `web.tlsAsk` to expose Caddy's domain check endpoint; it requires `web.sites` and permits configured fixed hosts or domains claimed by `resolveHost`.

```caddyfile
{
  on_demand_tls {
    ask http://127.0.0.1:<port>/.well-known/warlock/domain
  }
}
```

Boot fails for an unassigned page, a `$sites` folder without a matching `web.sites` entry, a configured site whose `$sites/<name>` folder is missing, a missing site root, overlapping fixed host plus base path, a page shadowing an `src/app` route, or inconsistent dynamic/resolver configuration. Page cache entries are partitioned by site and tenant key. Fix the declared ownership rather than depending on route order.

Out of scope: path- or session-selected tenants, sharing a root between sites, cross-site prefetch, API host scoping, and automatic Cascade query scoping.
