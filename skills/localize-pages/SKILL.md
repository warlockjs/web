---
name: localize-pages
description: 'Define route-owned `locales.json` dictionaries for SSR pages, use `useTrans()` and `useChangeLocaleCode()`, and maintain generated route translation key types. Triggers: `locales.json`, `$group`, `useTrans`, `useChangeLocaleCode`, `route translations`, `TranslationKeyRegistry`, `transFromKeywords`; "translate a page", "page-local copy", "route locale JSON", "switch locale". Skip: global module translations and localized database columns — `@warlock.js/core/use-localization/SKILL.md`.'
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

The server selects one immutable snapshot for route source and locale. The hydration payload contains only that locale's keywords and does not register them globally. `useTrans()`, `request.t()`, and `request.trans()` use the same snapshot, so concurrent renders cannot leak copy. A missing scoped key returns the key itself.

`request.t()`, `request.trans()`, and `request.transFrom(localeCode, keyword, placeholders?)` all resolve through the route snapshot while one applies. Without route-locales JSON, they retain the legacy global-registry behavior. `@mongez/localization` 3.5.0 exposes `transFromKeywords(localeCode, keywords, keyword, placeholders?, converter?)` for callers that supply a dictionary.

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

## See also

- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — navigation and refresh behavior.
- [`@warlock.js/core/use-localization/SKILL.md`](../../../core/skills/use-localization/SKILL.md) — global/module dictionaries and localized data columns.

## Configure locale and URL strategy

Route JSON requires a default locale included in the configured set:

```ts title="src/config/app.ts"
export default {
  localeCode: "en",
  localeCodes: ["en", "ar"],
};
```

Choose one URL strategy in web configuration: `none` keeps locale out of the path; `prefix` uses `/en/...` and `/ar/...`; `prefix-except-default` keeps the default locale bare and prefixes the others. A page whose filesystem route begins with `[locale]` carries its own locale segment and cannot be combined with a non-`none` URL prefix strategy.

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
