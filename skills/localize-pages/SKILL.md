---
name: localize-pages
description: 'Define route-owned `locales.json` dictionaries for SSR pages, use `useTrans()` and `useChangeLocaleCode()`, choose the locale URL strategy with `web.localeRouting.strategy` (`none`, `prefix`, `prefix-except-default`), build an en/ar page with a locale switcher, and maintain generated route translation key types. Triggers: `locales.json`, `$group`, `useTrans`, `useChangeLocaleCode`, `localeRouting`, `route translations`, `TranslationKeyRegistry`, `transFromKeywords`; "translate a page", "page-local copy", "route locale JSON", "switch locale", "/ar/ URL prefix", "language switcher". Skip: global module translations and localized database columns — the `use-localization` topic of the `warlock-js-core` skill.'
---

# Warlock — localize pages with route-owned JSON

Put `locales.json` under `src/web`. The build discovers it, validates every configured locale, and projects only the dictionaries belonging to each route.

## Define copy

```json title="src/web/account/locales.json"
{
  "$group": "account",
  "title": { "en": "Account", "ar": "Account (Arabic)" },
  "actions": { "save": { "en": "Save", "ar": "Save (Arabic)" } }
}
```

Every leaf is an object containing string values for every `app.localeCodes` entry. A leaf cannot mix locale strings with nested objects. JSON keys cannot contain dots; nesting becomes dotted lookup keys.

`$group` is optional and valid only at the root. It overrides the file namespace. Without it, the physical directory below `src/web` supplies the namespace, omitting group `(private)` and parameter `[id]` directories. Thus `src/web/account/[id]/locales.json` contributes `account.*`, while `src/web/locales.json` has no implicit prefix.

```tsx
import { useTrans } from "@warlock.js/web";

export default function AccountPage() {
  const t = useTrans();
  return <button>{t("account.actions.save")}</button>;
}
```

## Scope, errors, and legacy lookups

A page receives only `locales.json` files on its physical ancestor chain. A child file can contribute additional keys for that page. A sibling cannot contribute. Current ownership validation rejects duplicate flattened keys globally, including matching ancestor/child keys; any key that conflicts with a namespace prefix also fails the build.

The server selects one immutable snapshot for route source and locale. The hydration payload contains only that locale's keywords and does not register them globally. `useTrans()` on the client and `t()` from `@warlock.js/core` on the server (loaders, `metadata`) use the same snapshot, so concurrent renders cannot leak copy. A missing scoped key returns the key itself.

In loaders and `metadata`, translate with `t()` from `@warlock.js/core`, not `request.t()`. It resolves through the route snapshot while one applies, then falls back to module translations; `request.transFrom(localeCode, keyword, placeholders?)` is there for an explicit locale. Without route-locales JSON, it keeps the legacy global-registry behavior. `@mongez/localization` 3.5.0 exposes `transFromKeywords(localeCode, keywords, keyword, placeholders?, converter?)` for callers that supply a dictionary.

Error pages rebind to their own snapshot. If rendering falls through to the framework root, it uses the app/root snapshot, keeping error metadata, rendered copy, and hydration data aligned.

## Types and HMR

`warlock generate.typings` writes flattened keys to `.warlock/typings/translations.d.ts`. Keep that generated typings path included by `tsconfig.json`. Before generation `useTrans()` accepts strings; afterwards `TranslationKeyRegistry` catches misspelled literal keys.

In development, add, edit, and delete `locales.json` normally. HMR rebuilds the manifest and publishes a new snapshot. Its revision participates in page-cache selection, so cached payloads do not retain pre-edit JSON.

## Change locale from a component

```tsx title="src/web/components/locale-picker.tsx"
import { useState } from "react";
import { useChangeLocaleCode } from "@warlock.js/web";

export function LocalePicker() {
  const { changeLocaleCode, isLoading } = useChangeLocaleCode();
  const [error, setError] = useState<string>();
  const switchToArabic = async () => {
    setError(undefined);
    try {
      await changeLocaleCode("ar");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Locale switch failed");
    }
  };
  return (
    <button disabled={isLoading} onClick={switchToArabic}>
      {error ?? "Arabic"}
    </button>
  );
}
```

The hook returns `{ changeLocaleCode, changeLocale, isLoading }`; `changeLocale` is the deprecated compatibility alias. A successful switch rebuilds the current page with its selected locale snapshot. A rejected or superseded switch leaves the current UI unchanged.

## Configure locale and URL strategy

Route JSON requires a default locale included in the configured set (`app.localeCode` and `app.localeCodes`):

```ts title="src/config/app.ts"
export default {
  localeCode: "en",
  localeCodes: ["en", "ar"],
};
```

The URL strategy is the config key **`web.localeRouting.strategy`**, set in `src/config/web.ts`:

```ts title="src/config/web.ts"
import type { WebConfigurations } from "@warlock.js/web";

const web: WebConfigurations = {
  localeRouting: { strategy: "prefix-except-default" },
};

export default web;
```

| `strategy` | URLs | Locale comes from |
| --- | --- | --- |
| `"none"` (**default** when the key is absent) | `/about` for every locale | `?locale=`, then the browser preference cookie, then the legacy server cookie, then a `locale` request header, else `app.localeCode` |
| `"prefix"` | `/en/about`, `/ar/about`; a bare `/about` answers a 302 to the resolved locale's URL | the path prefix |
| `"prefix-except-default"` | `/about` (default locale), `/ar/about`; `/en/about` answers a 301 to `/about` | the path prefix, else the default locale |

Any other value, an empty `app.localeCodes`, or an `app.localeCode` that is not in `app.localeCodes` throws a `LocaleRoutingConfigError` at boot. A multi-site app can override the strategy per site with `sites.<key>.localeRouting` (see the `multi-site` topic). A page whose filesystem route begins with `[locale]` carries its own locale segment and cannot be combined with a non-`none` strategy (`LocaleParamRoutingConflictError` at boot). To build a locale-correct URL by hand, for a canonical link for example, use `localizedPath(path, locale?)` from `@warlock.js/web`; `<Link>` prefixes literal in-app paths itself (see the `navigate-on-the-client` topic for its `locale` prop).

## Worked example: an en/ar routed page with a switcher

With `app.localeCodes: ["en", "ar"]` and `strategy: "prefix-except-default"` as above, one page serves `/about` (English) and `/ar/about` (Arabic). There is no per-locale route to declare: the installers register the prefixed URLs for every page.

```json title="src/web/about/locales.json"
{
  "title": { "en": "About us", "ar": "من نحن" },
  "intro": { "en": "We build servers and pages.", "ar": "نبني الخوادم والصفحات." }
}
```

The directory (`about`) is the namespace, so the keys are `about.title` and `about.intro`.

```tsx title="src/web/about/about.page.tsx"
import { useTrans, type PageConfig } from "@warlock.js/web";

export const config = {
  route: { path: "/about", name: "about" },
} as const satisfies PageConfig;

export default function AboutPage() {
  const t = useTrans();

  return (
    <main>
      <h1>{t("about.title")}</h1>
      <p>{t("about.intro")}</p>
    </main>
  );
}
```

```tsx title="src/web/components/locale-switcher.tsx"
import { useState } from "react";
import { useChangeLocaleCode, useLocale } from "@warlock.js/web";

// Keep this list in step with app.localeCodes; the client has no export for it.
const LOCALES = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
] as const;

export function LocaleSwitcher() {
  const current = useLocale();
  const { changeLocaleCode, isLoading } = useChangeLocaleCode();
  const [failed, setFailed] = useState(false);

  const switchTo = async (code: string) => {
    setFailed(false);

    try {
      await changeLocaleCode(code);
    } catch {
      setFailed(true);
    }
  };

  return (
    <div role="group" aria-label="Language">
      {LOCALES.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={code === current}
          disabled={isLoading || code === current}
          onClick={() => switchTo(code)}
        >
          {label}
        </button>
      ))}
      {failed ? <span role="alert">Could not switch language.</span> : null}
    </div>
  );
}
```

Render `<LocaleSwitcher />` from a layout (see "Root and layout integration" below). Clicking "العربية" on `/about` re-fetches the page for the new locale, pushes `/ar/about`, and updates `<html lang dir>` when the root derives them from `useLocale()` / `useTextDirection()`. Under `prefix` and `prefix-except-default` the switch is a real URL change (`changeLocaleCode` re-prefixes the current path and keeps the query and hash); under `none` it re-fetches the current URL with `?locale=<code>` and records the choice in the browser preference cookie only once the new page is ready.

## Root and layout integration

The document root owns `<html lang>` and `dir`, and it must keep the hydrated Layout + Page subtree inside `#vessel`:

```tsx title="src/web/root.tsx"
import { Head, Scripts, useLocale, useTextDirection, type AppProps } from "@warlock.js/web";

export default function App({ children }: AppProps) {
  return (
    <html lang={useLocale()} dir={useTextDirection()}>
      <head>
        <Head />
      </head>
      <body>
        <div id="vessel">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
```

Put interactive locale controls in a layout or page beneath `#vessel`, where hydration runs:

```tsx title="src/web/account/layout.tsx"
import { LocalePicker } from "../components/locale-picker";
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LocalePicker />
      {children}
    </>
  );
}
```

## See also

- The `navigate-on-the-client` topic: navigation, refresh, and `<Link>`'s `locale` prop.
- The `use-localization` topic of the `warlock-js-core` skill: global/module dictionaries and localized data columns.
- The `multi-site` topic: per-site `localeRouting`.
